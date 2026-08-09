import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, record, getOptions } from "../src/index.js";
import {
  captureQueries,
  expectNoNPlusOne,
  expectQueryCount,
  NPlusOneAssertionError,
} from "../src/test.js";

beforeEach(() => {
  resetConfig();
  configure({ enabled: true });
});

test("captureQueries returns what ran without reporting", async () => {
  const result = await captureQueries(() => {
    record({ sql: "SELECT * FROM users WHERE id = $1", params: [1] });
    record({ sql: "SELECT * FROM orders WHERE user_id = $1", params: [1] });
  });

  assert.equal(result.queries.length, 2);
  assert.equal(result.summary.queryCount, 2);
  assert.deepEqual(result.findings, []);
});

test("expectNoNPlusOne passes on a batched query", async () => {
  await expectNoNPlusOne(() => {
    record({ sql: "SELECT * FROM orders WHERE user_id = $1", params: [1] });
    record({ sql: "SELECT * FROM items WHERE order_id = ANY($1)", params: [[1, 2, 3]] });
  });
});

test("expectNoNPlusOne fails on a loop, naming the line", async () => {
  await assert.rejects(
    () =>
      expectNoNPlusOne(
        () => {
          for (let i = 0; i < 6; i++) {
            record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
          }
        },
        { name: "orders page" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof NPlusOneAssertionError);
      assert.equal(error.findings.length, 1);
      assert.match(error.message, /Expected no N\+1 queries in orders page/);
      assert.match(error.message, /assert\.test\./);
      return true;
    },
  );
});

test("expectNoNPlusOne ignores duplicates unless asked", async () => {
  const run = () => {
    record({ sql: "SELECT * FROM settings WHERE id = $1", params: [1] });
    record({ sql: "SELECT * FROM settings WHERE id = $1", params: [1] });
  };

  await expectNoNPlusOne(run);
  await assert.rejects(
    () => expectNoNPlusOne(run, { includeDuplicates: true }),
    NPlusOneAssertionError,
  );
});

test("expectQueryCount enforces a ceiling", async () => {
  await expectQueryCount(() => {
    record({ sql: "SELECT 1" });
    record({ sql: "SELECT 2" });
  }, 2);

  await assert.rejects(
    () =>
      expectQueryCount(() => {
        record({ sql: "SELECT 1" });
        record({ sql: "SELECT 2" });
        record({ sql: "SELECT 3" });
      }, 2),
    /Expected at most 2 queries, got 3/,
  );
});

test("helpers restore the previous configuration", async () => {
  configure({ mode: "warn", threshold: 9 });
  const before = getOptions();

  await captureQueries(() => {
    record({ sql: "SELECT 1" });
  });

  const after = getOptions();
  assert.equal(after.mode, "warn");
  assert.equal(after.threshold, 9);
  assert.equal(after.enabled, before.enabled);
});

test("helpers work even when detection is globally disabled", async () => {
  // A test suite should not have to remember to turn the detector on.
  configure({ enabled: false });

  await assert.rejects(
    () =>
      expectNoNPlusOne(() => {
        for (let i = 0; i < 6; i++) {
          record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
        }
      }),
    NPlusOneAssertionError,
  );

  assert.equal(getOptions().enabled, false, "the override should not leak");
});
