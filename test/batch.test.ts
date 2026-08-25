import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import { observeBatch } from "../src/adapters/shared.js";

/**
 * Batches.
 *
 * An N+1 counts **round trips**, not statements. A driver that carries fifty
 * statements in one request has done one round trip, and reporting that as an
 * N+1 would argue against the exact thing someone fixing an N+1 is told to
 * write — a pipeline, an `executeMany`, an `IN (...)`.
 *
 * So every statement in one batch shares a discriminator. The consequence worth
 * testing is not just "a batch is quiet": it is that a loop *of* batches is
 * still loud, because that is a real N+1 wearing a batch costume.
 */

function batchOf(count: number, offset = 0): { sql: string; params: unknown[] }[] {
  return Array.from({ length: count }, (_unused, i) => ({
    sql: "SELECT * FROM items WHERE order_id = ?",
    params: [offset + i],
  }));
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true, threshold: 5, captureStack: false });
});

test("one batch of fifty is not an N+1 — it is the fix", async () => {
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("batched", (scope) => {
    observeBatch(batchOf(50), () => undefined);
    assert.equal(scope.queryCount, 50, "the statements are still recorded");
  });

  assert.equal(
    findings.find((f) => f.type === "n_plus_one"),
    undefined,
  );
});

test("a loop of batches is still an N+1, counted in round trips", async () => {
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("looped batches", () => {
    // Seven round trips, twenty statements each. The round trips are the bug.
    for (let trip = 0; trip < 7; trip++) {
      observeBatch(batchOf(20, trip * 20), () => undefined);
    }
  });

  const finding = findings.find((f) => f.type === "n_plus_one");
  assert.ok(finding, "seven round trips from one line is an N+1");
  assert.equal(finding.count, 140, "the count still reports every statement");
});

test("a batch does not top up an unbatched loop towards the threshold", async () => {
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("mixed", (scope) => {
    // Three real round trips, plus one batch of thirty. Four round trips is
    // under the threshold of five, and that is the honest reading.
    for (let id = 0; id < 3; id++) {
      scope.record({ sql: "SELECT * FROM items WHERE order_id = ?", params: [id] });
    }
    observeBatch(batchOf(30, 100), () => undefined);
  });

  assert.equal(
    findings.find((f) => f.type === "n_plus_one"),
    undefined,
  );
});

test("a batched finding never reports batch ids as sampled values", async () => {
  // The discriminator for a batched statement is the batch, not a parameter
  // set. Printing `batch#7` under a heading that says "values" would
  // misdescribe what the reader is looking at.
  configure({ sampleValues: 5 });
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("sampled", () => {
    for (let trip = 0; trip < 7; trip++) {
      observeBatch(batchOf(3, trip * 3), () => undefined);
    }
  });

  const finding = findings.find((f) => f.type === "n_plus_one");
  assert.ok(finding);
  assert.equal(finding.values, undefined);
});

test("an empty batch records nothing", async () => {
  await runInScope("empty", (scope) => {
    observeBatch([], () => undefined);
    assert.equal(scope.queryCount, 0);
  });
});
