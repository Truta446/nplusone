import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import { instrumentLibsql } from "../src/adapters/libsql.js";

type Statement =
  | string
  | {
      sql: string;
      args?: readonly unknown[] | Record<string, unknown>;
    };

class FakeLibsqlClient {
  executeCalls = 0;
  batchCalls = 0;

  execute(_statement: Statement): Promise<{ rows: unknown[] }> {
    this.executeCalls += 1;
    return Promise.resolve({ rows: [] });
  }

  batch(statements: Statement[]): Promise<Array<{ rows: unknown[] }>> {
    this.batchCalls += 1;
    return Promise.resolve(statements.map(() => ({ rows: [] })));
  }
}

/** Takes a measurable amount of time, so timings can be asserted on. */
class SlowLibsqlClient extends FakeLibsqlClient {
  static readonly DELAY_MS = 40;

  override async batch(
    statements: Statement[],
  ): Promise<Array<{ rows: unknown[] }>> {
    await new Promise((resolve) => setTimeout(resolve, SlowLibsqlClient.DELAY_MS));
    return super.batch(statements);
  }
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("records string and object execute call shapes", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  configure({ threshold: 1000 });

  await runInScope("execute", async (scope) => {
    await client.execute("SELECT 1");
    await client.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [7],
    });
    await client.execute({
      sql: "SELECT * FROM users WHERE id = :id",
      args: { id: 8 },
    });

    assert.equal(scope.queryCount, 3);
    assert.equal(scope.queries[0]!.sql, "SELECT 1");
    assert.deepEqual(scope.queries[1]!.params, [7]);
    assert.deepEqual(scope.queries[2]!.params, [{ id: 8 }]);
  });

  restore();
  assert.equal(client.executeCalls, 3, "the original execute method still ran");
});

test("records each statement in a batch separately", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  const findings: Finding[] = [];
  configure({ threshold: 4, onFinding: (finding) => findings.push(finding) });

  await runInScope("batch", async (scope) => {
    await client.batch(
      Array.from({ length: 6 }, (_, id) => ({
        sql: "SELECT * FROM items WHERE order_id = ?",
        args: [id],
      })),
    );

    assert.equal(scope.queryCount, 6);
    assert.deepEqual(
      scope.queries.map((query) => query.params),
      [[0], [1], [2], [3], [4], [5]],
    );
  });

  restore();
  assert.equal(client.batchCalls, 1, "one batch remains one driver call");
  assert.equal(findings.filter((finding) => finding.type === "n_plus_one").length, 1);
});

test("restore stops recording", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  restore();

  await runInScope("restored", async (scope) => {
    await client.execute("SELECT 1");
    assert.equal(scope.queryCount, 0);
  });
});

test("instrumenting twice does not double count", async () => {
  const client = new FakeLibsqlClient();
  const restoreA = instrumentLibsql(client);
  const restoreB = instrumentLibsql(client);
  configure({ threshold: 1000 });

  await runInScope("double", async (scope) => {
    await client.execute("SELECT 1");
    assert.equal(scope.queryCount, 1);
  });

  restoreB();
  restoreA();
});

test("does not multiply the time a batch actually took", async () => {
  const client = new SlowLibsqlClient();
  const restore = instrumentLibsql(client);
  configure({ threshold: 1000 });

  const statements = Array.from({ length: 5 }, (_, id) => ({
    sql: "SELECT * FROM items WHERE order_id = ?",
    args: [id],
  }));

  let elapsed = 0;
  let reported = 0;
  await runInScope("timing", async (scope) => {
    const started = performance.now();
    await client.batch(statements);
    elapsed = performance.now() - started;
    reported = scope.queries.reduce((sum, query) => sum + (query.durationMs ?? 0), 0);
  });
  restore();

  // Wrapping each statement in its own observe() nests the timers, so every
  // outer one contains all the inner ones and five statements report roughly
  // five times the truth. The batch is one round trip: the total is what the
  // round trip cost, however it is divided between the statements.
  assert.ok(
    reported <= elapsed * 1.5,
    `reported ${reported.toFixed(1)}ms for a batch that took ${elapsed.toFixed(1)}ms`,
  );
  assert.ok(reported > 0, "a batch that took real time must report some of it");
});

test("rejects an invalid client", () => {
  assert.throws(
    () => instrumentLibsql({} as never),
    /expected a client with execute\(\) and batch\(\)/,
  );
});
