/**
 * sampleValues — showing the differing values on an N+1 (#19).
 *
 * The finding tells you the shape, the count and the line. What it could not
 * tell you was which values varied, which is how you decide whether the loop
 * ran over ten rows or ten thousand, and how you reproduce it in a console.
 *
 * It is opt-in, and the tests below pin that: this is the only part of the
 * report that puts real data on stderr.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  configure,
  resetConfig,
  record,
  runInScope,
  formatFinding,
  type Finding,
} from "../src/index.js";

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true, threshold: 3 });
});

function nPlusOne(ids: readonly unknown[]): void {
  for (const id of ids) {
    record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [id] });
  }
}

function firstNPlusOne(findings: readonly Finding[]): Finding | undefined {
  return findings.find((f) => f.type === "n_plus_one");
}

test("shows nothing by default", async () => {
  await runInScope("default", async (scope) => {
    nPlusOne([1, 2, 3, 4]);
    // Upgrading must not start printing parameters on its own.
    assert.equal(firstNPlusOne(scope.findings)?.values, undefined);
  });
});

test("samples the distinct values when asked", async () => {
  configure({ sampleValues: 3 });

  await runInScope("sampled", async (scope) => {
    nPlusOne([1, 2, 3, 4, 5, 6]);
    const finding = firstNPlusOne(scope.findings);

    assert.deepEqual(finding?.values, ["[1]", "[2]", "[3]"]);
    assert.equal(finding?.count, 6, "the sample is capped, the count is not");
  });
});

test("keeps sampling after the threshold is crossed", async () => {
  configure({ sampleValues: 5, threshold: 2 });

  await runInScope("late", async (scope) => {
    nPlusOne([1, 2, 3, 4, 5]);
    // The finding is created on the second query. A sample frozen at that
    // moment would show two values for a loop of five.
    assert.deepEqual(firstNPlusOne(scope.findings)?.values, [
      "[1]",
      "[2]",
      "[3]",
      "[4]",
      "[5]",
    ]);
  });
});

test("says nothing when the driver reported no parameters", async () => {
  configure({ sampleValues: 5 });

  await runInScope("interpolated", async (scope) => {
    // Some drivers interpolate values into the SQL. The discriminator is then
    // the whole statement, which is already on the report — listing statements
    // under a heading that says "values" would misdescribe them.
    for (const id of [1, 2, 3, 4]) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
    assert.equal(firstNPlusOne(scope.findings)?.values, undefined);
  });
});

test("never attaches values to a duplicate finding", async () => {
  configure({ sampleValues: 5, duplicateThreshold: 2 });

  await runInScope("duplicate", async (scope) => {
    // Identical parameters by definition, so a sample of them says nothing.
    record({ sql: "SELECT * FROM settings WHERE user_id = $1", params: [7] });
    record({ sql: "SELECT * FROM settings WHERE user_id = $1", params: [7] });

    const duplicate = scope.findings.find((f) => f.type === "duplicate");
    assert.ok(duplicate !== undefined);
    assert.equal(duplicate.values, undefined);
  });
});

test("truncates a long value rather than dumping it", async () => {
  configure({ sampleValues: 2 });

  await runInScope("long", async (scope) => {
    for (let i = 0; i < 4; i++) {
      record({ sql: "SELECT * FROM blobs WHERE body = $1", params: [`${"x".repeat(500)}${i}`] });
    }

    const values = firstNPlusOne(scope.findings)?.values ?? [];
    assert.equal(values.length, 2);
    for (const value of values) {
      assert.ok(value.length <= 60, `value was ${value.length} characters`);
      assert.ok(value.endsWith("…"), "a cut value has to look cut");
    }
  });
});

test("renders the values with a count of what was left out", async () => {
  configure({ sampleValues: 2 });

  let finding: Finding | undefined;
  await runInScope("render", async (scope) => {
    nPlusOne([1, 2, 3, 4, 5]);
    finding = firstNPlusOne(scope.findings);
  });

  const text = formatFinding(finding!);
  assert.match(text, /values: \[1\], \[2\]/);
  assert.match(text, /and 3 more/);
});

test("does not add a values line when there is nothing to show", async () => {
  let finding: Finding | undefined;
  await runInScope("plain", async (scope) => {
    nPlusOne([1, 2, 3, 4]);
    finding = firstNPlusOne(scope.findings);
  });

  assert.doesNotMatch(formatFinding(finding!), /values:/);
});
