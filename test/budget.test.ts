/**
 * maxQueries — the budget check (#3).
 *
 * Not every expensive request repeats itself. An endpoint that issues fourteen
 * *different* statements to render one page has no N+1 in it and, until this
 * option existed, the detector said nothing at all about it.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  configure,
  resetConfig,
  record,
  runInScope,
  resetScopeWarning,
  formatFinding,
  type Finding,
  type ScopeSummary,
} from "../src/index.js";
import { expectNoNPlusOne, expectQueryCount } from "../src/test.js";

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
  resetScopeWarning();
});

/** `n` statements that are all different, so nothing can be a repetition. */
async function distinctQueries(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    record({ sql: `SELECT * FROM table_${i} WHERE id = $1`, params: [1] });
  }
}

test("says nothing when no budget is set", async () => {
  let summary: ScopeSummary | undefined;
  await runInScope("no budget", async (scope) => {
    await distinctQueries(50);
    summary = scope.summary();
  });

  // The default must never add noise on upgrade.
  assert.equal(summary?.findings.length, 0);
});

test("reports a scope that goes over its budget", async () => {
  const findings: Finding[] = [];
  configure({ maxQueries: 10, onFinding: (f) => findings.push(f) });

  await runInScope("GET /admin/record", () => distinctQueries(14));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.type, "too_many_queries");
  assert.equal(findings[0]!.count, 14);
  assert.equal(findings[0]!.scope, "GET /admin/record");
  // No single line is to blame — that is the honest answer, not an arbitrary
  // frame picked from a scope where every query came from somewhere different.
  assert.equal(findings[0]!.callsite, undefined);
});

test("stays silent at the budget and one below it", async () => {
  const findings: Finding[] = [];
  configure({ maxQueries: 10, onFinding: (f) => findings.push(f) });

  await runInScope("exactly at", () => distinctQueries(10));
  await runInScope("one below", () => distinctQueries(9));

  assert.equal(findings.length, 0, "the budget is a maximum, not a ceiling to stay under");
});

test("lists where the budget went, most frequent first", async () => {
  configure({ maxQueries: 3 });

  let finding: Finding | undefined;
  await runInScope("breakdown", async (scope) => {
    for (let i = 0; i < 5; i++) record({ sql: "SELECT * FROM items", params: [] });
    for (let i = 0; i < 2; i++) record({ sql: "SELECT * FROM users", params: [] });
    record({ sql: "SELECT * FROM orders", params: [] });
    finding = scope.close().findings.find((f) => f.type === "too_many_queries");
  });

  assert.deepEqual(
    finding?.breakdown?.map((row) => [row.normalized, row.count]),
    [
      ["SELECT * FROM items", 5],
      ["SELECT * FROM users", 2],
      ["SELECT * FROM orders", 1],
    ],
  );
});

test("caps the breakdown so a wide scope stays a report", async () => {
  configure({ maxQueries: 5 });

  let finding: Finding | undefined;
  await runInScope("wide", async (scope) => {
    await distinctQueries(40);
    finding = scope.close().findings.find((f) => f.type === "too_many_queries");
  });

  assert.equal(finding?.count, 40, "the count is the total, not the listed rows");
  assert.equal(finding?.breakdown?.length, 10);
});

test("coexists with an N+1 in the same scope", async () => {
  const findings: Finding[] = [];
  configure({ maxQueries: 5, threshold: 3, onFinding: (f) => findings.push(f) });

  await runInScope("both", async () => {
    for (let i = 0; i < 8; i++) {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
    }
  });

  const types = findings.map((f) => f.type).sort();
  assert.deepEqual(types, ["n_plus_one", "too_many_queries"]);
  // The N+1 keeps its own line; the budget finding is about the total.
  assert.equal(findings.find((f) => f.type === "n_plus_one")!.count, 8);
  assert.equal(findings.find((f) => f.type === "too_many_queries")!.count, 8);
});

test("never throws, even in throw mode", async () => {
  configure({ maxQueries: 2, mode: "throw" });

  // The check runs from `close()`, which for a request is a `finally` block or
  // a `finish` handler. Throwing there would replace whatever error the handler
  // was already dealing with, or take the process down.
  await assert.doesNotReject(async () => {
    await runInScope("throwing mode", () => distinctQueries(10));
  });
});

test("does not mask an error thrown by the scope body", async () => {
  configure({ maxQueries: 1 });

  await assert.rejects(
    runInScope("failing", async () => {
      await distinctQueries(5);
      throw new Error("the real failure");
    }),
    /the real failure/,
  );
});

test("expectNoNPlusOne ignores a budget finding", async () => {
  // Its name promises one thing; failing for a different reason would be a
  // confusing way to learn about a new option.
  await assert.doesNotReject(
    expectNoNPlusOne(() => distinctQueries(20), { maxQueries: 5 }),
  );
  await assert.doesNotReject(
    expectNoNPlusOne(() => distinctQueries(20), { maxQueries: 5, includeDuplicates: true }),
  );
});

test("expectQueryCount is unchanged", async () => {
  await assert.rejects(
    expectQueryCount(() => distinctQueries(12), 10),
    /Expected at most 10 queries, got 12/,
  );
  await assert.doesNotReject(expectQueryCount(() => distinctQueries(3), 10));
});

test("a custom reporter receives the budget finding", async () => {
  const summaries: ScopeSummary[] = [];
  configure({ maxQueries: 2, mode: "warn", reporter: (s) => summaries.push(s) });

  await runInScope("reported", () => distinctQueries(4));

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.findings.length, 1);
  assert.equal(summaries[0]!.findings[0]!.type, "too_many_queries");
});

test("renders as a total and a breakdown, with no call site line", async () => {
  configure({ maxQueries: 2 });

  let finding: Finding | undefined;
  await runInScope("render", async (scope) => {
    record({ sql: "SELECT * FROM items", params: [] });
    record({ sql: "SELECT * FROM items", params: [] });
    record({ sql: "SELECT * FROM users", params: [] });
    // The identical pair also produces a duplicate finding, so pick by type
    // rather than by position.
    finding = scope.close().findings.find((f) => f.type === "too_many_queries");
  });

  const text = formatFinding(finding!);
  assert.match(text, /Query budget/);
  assert.match(text, /3 queries in one scope \(limit 2\)/);
  assert.match(text, /2× SELECT \* FROM items/);
  assert.doesNotMatch(text, /<unknown call site>/, "there is no line, so do not print one");
});
