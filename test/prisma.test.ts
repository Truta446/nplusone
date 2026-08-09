import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import { instrumentPrisma } from "../src/adapters/prisma.js";

/**
 * Stands in for a PrismaClient. `$extends` receives the extension and returns a
 * new client whose operations route through the registered `$allOperations`
 * hook — the same contract the real client implements.
 */
interface Handler {
  (input: {
    model?: string;
    operation: string;
    args: unknown;
    query: (args: unknown) => Promise<unknown>;
  }): Promise<unknown>;
}

function fakePrisma() {
  const executed: string[] = [];

  const client = {
    $extends(extension: { query: { $allOperations: Handler } }) {
      const handler = extension.query.$allOperations;
      const run = (model: string | undefined, operation: string) => (args: unknown) =>
        handler({
          ...(model === undefined ? {} : { model }),
          operation,
          args,
          query: async (a: unknown) => {
            executed.push(`${model ?? ""}.${operation}`);
            void a;
            return [{ id: 1 }];
          },
        });

      return {
        user: {
          findUnique: run("User", "findUnique"),
          findMany: run("User", "findMany"),
          create: run("User", "create"),
        },
        $queryRaw: run(undefined, "$queryRaw"),
      };
    },
  };

  return { client, executed };
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("detects an N+1 across Prisma model calls", async () => {
  const { client, executed } = fakePrisma();
  const prisma = instrumentPrisma(client) as unknown as {
    user: { findUnique: (a: unknown) => Promise<unknown> };
  };

  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  await runInScope("GET /users", async () => {
    for (let i = 0; i < 8; i++) {
      await prisma.user.findUnique({ where: { id: i } });
    }
  });

  assert.equal(executed.length, 8, "the underlying operation still ran");
  const nPlusOnes = findings.filter((f) => f.type === "n_plus_one");
  assert.equal(nPlusOnes.length, 1);
  assert.equal(nPlusOnes[0]!.count, 8);
  assert.equal(
    nPlusOnes[0]!.normalized,
    "User.findUnique",
    "the operation is what you would batch, so that is what gets reported",
  );
});

test("classifies reads as selects so the statements filter works", async () => {
  const { client } = fakePrisma();
  const prisma = instrumentPrisma(client) as unknown as {
    user: {
      findUnique: (a: unknown) => Promise<unknown>;
      create: (a: unknown) => Promise<unknown>;
    };
  };

  const findings: Finding[] = [];
  configure({ threshold: 3, statements: ["select"], onFinding: (f) => findings.push(f) });

  await runInScope("mixed", async () => {
    for (let i = 0; i < 4; i++) await prisma.user.create({ data: { id: i } });
    for (let i = 0; i < 4; i++) await prisma.user.findUnique({ where: { id: i } });
  });

  assert.equal(findings.length, 1, "only the reads should be considered");
  assert.equal(findings[0]!.normalized, "User.findUnique");
  assert.equal(findings[0]!.kind, "select");
});

test("treats identical arguments as duplicates, not an N+1", async () => {
  const { client } = fakePrisma();
  const prisma = instrumentPrisma(client) as unknown as {
    user: { findUnique: (a: unknown) => Promise<unknown> };
  };

  const findings: Finding[] = [];
  configure({ threshold: 3, duplicateThreshold: 2, onFinding: (f) => findings.push(f) });

  await runInScope("same-args", async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.user.findUnique({ where: { id: 7 } });
    }
  });

  assert.deepEqual(findings.filter((f) => f.type === "n_plus_one"), []);
  assert.equal(findings.filter((f) => f.type === "duplicate").length, 1);
});

test("rejects anything without $extends", () => {
  assert.throws(
    () => instrumentPrisma({} as never),
    /expected a PrismaClient instance/,
  );
});
