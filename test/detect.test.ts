import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  configure,
  resetConfig,
  record,
  runInScope,
  NPlusOneError,
  resetScopeWarning,
  type Finding,
} from "../src/index.js";

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
  resetScopeWarning();
});

/** Simulates the classic loop: one parent query, then one child query per row. */
async function nPlusOne(rows: number): Promise<void> {
  record({ sql: "SELECT * FROM orders WHERE user_id = $1", params: [1] });
  for (let i = 0; i < rows; i++) {
    record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
  }
}

test("flags a query shape repeated with different values", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  await runInScope("GET /orders", () => nPlusOne(10));

  const nPlusOnes = findings.filter((f) => f.type === "n_plus_one");
  assert.equal(nPlusOnes.length, 1);
  assert.equal(nPlusOnes[0]!.count, 10);
  assert.equal(nPlusOnes[0]!.normalized, "SELECT * FROM items WHERE order_id = ?");
  assert.equal(nPlusOnes[0]!.scope, "GET /orders");
});

test("stays quiet below the threshold", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  await runInScope("small", () => nPlusOne(4));

  assert.deepEqual(findings.filter((f) => f.type === "n_plus_one"), []);
});

test("counts distinct values, not raw repetitions", async () => {
  // Ten executions but only one distinct parameter — that is a duplicate
  // query, not an N+1, and conflating them is the classic false positive.
  const findings: Finding[] = [];
  configure({ threshold: 5, duplicateThreshold: 1000, onFinding: (f) => findings.push(f) });

  await runInScope("same-value", () => {
    for (let i = 0; i < 10; i++) {
      record({ sql: "SELECT * FROM users WHERE id = $1", params: [7] });
    }
  });

  assert.deepEqual(findings.filter((f) => f.type === "n_plus_one"), []);
});

test("flags an identical query repeated within one scope", async () => {
  const findings: Finding[] = [];
  configure({ duplicateThreshold: 2, onFinding: (f) => findings.push(f) });

  await runInScope("dup", () => {
    record({ sql: "SELECT * FROM settings WHERE id = $1", params: [1] });
    record({ sql: "SELECT * FROM settings WHERE id = $1", params: [1] });
  });

  const dups = findings.filter((f) => f.type === "duplicate");
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.count, 2);
});

test("treats different parameters as different queries for duplicates", async () => {
  const findings: Finding[] = [];
  configure({ duplicateThreshold: 2, threshold: 1000, onFinding: (f) => findings.push(f) });

  await runInScope("no-dup", () => {
    record({ sql: "SELECT * FROM users WHERE id = $1", params: [1] });
    record({ sql: "SELECT * FROM users WHERE id = $1", params: [2] });
  });

  assert.deepEqual(findings.filter((f) => f.type === "duplicate"), []);
});

test("detects N+1 when the driver interpolates values into the SQL", async () => {
  // No params array: the values live in the statement itself, so the raw SQL
  // has to act as the discriminator.
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  await runInScope("raw-sql", () => {
    for (let i = 0; i < 8; i++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${i}` });
    }
  });

  const nPlusOnes = findings.filter((f) => f.type === "n_plus_one");
  assert.equal(nPlusOnes.length, 1);
  assert.equal(nPlusOnes[0]!.count, 8);
});

test("does not carry counts across scopes", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  for (let request = 0; request < 10; request++) {
    await runInScope(`req-${request}`, () => {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [request] });
    });
  }

  assert.deepEqual(findings, []);
});

test("keeps concurrent scopes isolated", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  const slowLoop = runInScope("A", async () => {
    for (let i = 0; i < 3; i++) {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
      await new Promise((r) => setTimeout(r, 1));
    }
  });
  const otherLoop = runInScope("B", async () => {
    for (let i = 0; i < 3; i++) {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i + 100] });
      await new Promise((r) => setTimeout(r, 1));
    }
  });

  await Promise.all([slowLoop, otherLoop]);

  // Six queries interleaved, but three per scope — under the threshold in both.
  assert.deepEqual(findings, []);
});

test("throw mode raises at the offending query", async () => {
  configure({ threshold: 3, mode: "throw" });

  await assert.rejects(
    () => runInScope("strict", () => nPlusOne(10)),
    (error: unknown) => {
      assert.ok(error instanceof NPlusOneError);
      assert.equal(error.finding.type, "n_plus_one");
      assert.match(error.message, /ran 3 times/);
      return true;
    },
  );
});

test("attributes the query to the calling line", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });

  await runInScope("attribution", () => {
    for (let i = 0; i < 5; i++) {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
    }
  });

  const site = findings[0]?.callsite;
  assert.ok(site !== undefined, "expected a call site");
  assert.match(site.file, /detect\.test\./);
  assert.ok(site.line > 0);
});

test("separates identical SQL issued from different lines", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });
  const sql = "SELECT * FROM items WHERE order_id = $1";

  await runInScope("two-sites", () => {
    for (let i = 0; i < 2; i++) record({ sql, params: [i] });
    for (let i = 10; i < 12; i++) record({ sql, params: [i] });
  });

  // Two lines, two queries each — neither reaches a threshold of three.
  assert.deepEqual(findings.filter((f) => f.type === "n_plus_one"), []);
});

test("respects the statements filter", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 3, statements: ["select"], onFinding: (f) => findings.push(f) });

  await runInScope("writes", () => {
    for (let i = 0; i < 10; i++) {
      record({ sql: "INSERT INTO audit (id) VALUES ($1)", params: [i] });
    }
  });

  assert.deepEqual(findings, []);
});

test("honours the ignore list", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 3, ignore: [/pg_catalog/], onFinding: (f) => findings.push(f) });

  await runInScope("noise", () => {
    for (let i = 0; i < 10; i++) {
      record({ sql: `SELECT * FROM pg_catalog.pg_type WHERE oid = ${i}` });
    }
  });

  assert.deepEqual(findings, []);
});

test("ignores queries recorded outside a scope", () => {
  configure({ threshold: 2 });
  const result = record({ sql: "SELECT 1" });
  assert.equal(result, undefined);
});

test("does nothing when disabled", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 2, enabled: false, onFinding: (f) => findings.push(f) });

  const summary = await runInScope("off", () => nPlusOne(10)).then(() => undefined);
  assert.equal(summary, undefined);
  assert.deepEqual(findings, []);
});

test("sums the time spent in the repeated query", async () => {
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });

  const summary = await runInScope("timing", () => {
    for (let i = 0; i < 4; i++) {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i], durationMs: 2.5 });
    }
  }).then(() => undefined);

  assert.equal(summary, undefined);
  const finding = findings.find((f) => f.type === "n_plus_one");
  assert.ok(finding !== undefined);
  assert.equal(finding.count, 4);
  assert.equal(finding.totalDurationMs, 10);
});

test("reports the scope summary once it closes", async () => {
  const summaries: string[] = [];
  configure({
    threshold: 3,
    mode: "warn",
    reporter: (s) => summaries.push(`${s.name}:${s.findings.length}:${s.queryCount}`),
  });

  await runInScope("GET /orders", () => nPlusOne(5));

  assert.equal(summaries.length, 1);
  assert.match(summaries[0]!, /^GET \/orders:1:6$/);
});
