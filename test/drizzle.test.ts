/**
 * The Drizzle adapter exists for one reason: attribution. So these tests check
 * *which line* gets reported, not merely that something was recorded.
 *
 * The decisive case is building a query on one line and awaiting it on
 * another. Driver-level capture would report the await; the adapter must
 * report the line that built the query.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, record, runInScope, type Finding } from "../src/index.js";
import { captureNow } from "../src/adapters/shared.js";
import { instrumentDrizzle } from "../src/adapters/drizzle.js";

/**
 * Mimics Drizzle's shape: lazy thenables, chained builders that return `this`,
 * and a builder-to-builder transition (`insert().values()`).
 *
 * `execute` stands in for the driver adapter — it is what calls `captureNow()`,
 * exactly as the real pg/postgres.js adapters do.
 */
function fakeDrizzle() {
  class Builder implements PromiseLike<unknown> {
    #params: unknown[] = [];

    constructor(readonly sql: string) {}

    from(_table: string): this {
      return this;
    }
    where(condition: unknown): this {
      // Kept so an N+1 loop produces varying parameters, the way a real one
      // does — identical parameters would be a duplicate, not an N+1.
      this.#params = [condition];
      return this;
    }
    limit(_n: number): this {
      return this;
    }

    then<TResult1 = unknown, TResult2 = never>(
      onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve()
        .then(() => {
          // The driver records here, one tick after the caller's frame is gone.
          record({ sql: this.sql, params: this.#params, callsite: captureNow() });
          return [{ id: 1 }] as unknown;
        })
        .then(onFulfilled, onRejected);
    }
  }

  return {
    select: () => new Builder("select * from t"),
    insert: (_table: string) => ({
      values: (_v: unknown) => new Builder("insert into t values (?)"),
    }),
    query: {
      users: {
        findMany: (_args?: unknown) => new Builder("select * from users"),
      },
    },
    transaction: async (
      callback: (tx: { select: () => PromiseLike<unknown> }) => unknown,
    ) => callback({ select: () => new Builder("select * from t") }),
  };
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true, threshold: 1000 });
});

test("reports the line that built the query, not the line that awaited it", async () => {
  const db = instrumentDrizzle(fakeDrizzle());

  // Building inside a named function makes the assertion independent of line
  // numbers, which shift when this file is edited or compiled.
  function buildTheQuery(): PromiseLike<unknown> {
    return db.select().from("orders").where("x");
  }

  let attributedTo = "";
  await runInScope("split", async (scope) => {
    const query = buildTheQuery();
    await query;
    attributedTo = scope.queries[0]?.callsite?.function ?? "";
  });

  assert.match(
    attributedTo,
    /buildTheQuery/,
    "attribution must point at construction, not at the await that triggered execution",
  );
});

test("keeps attribution across a builder-to-builder transition", async () => {
  const db = instrumentDrizzle(fakeDrizzle());

  // `insert()` returns one object and `.values()` returns another; the call
  // site has to survive the hand-off.
  let file = "";
  await runInScope("insert", async (scope) => {
    await db.insert("items").values({ id: 1 });
    file = scope.queries[0]?.callsite?.file ?? "";
  });

  assert.match(file, /drizzle\.test\./);
});

test("attributes queries built through db.query", async () => {
  const db = instrumentDrizzle(fakeDrizzle());

  let file = "";
  await runInScope("relational", async (scope) => {
    await db.query.users.findMany({ where: 1 });
    file = scope.queries[0]?.callsite?.file ?? "";
  });

  assert.match(file, /drizzle\.test\./);
});

test("attributes queries issued inside a transaction", async () => {
  const db = instrumentDrizzle(fakeDrizzle());

  let file = "";
  await runInScope("tx", async (scope) => {
    await db.transaction(async (tx: { select: () => PromiseLike<unknown> }) => {
      await tx.select();
    });
    file = scope.queries[0]?.callsite?.file ?? "";
  });

  assert.match(file, /drizzle\.test\./, "the scoped tx object must be instrumented too");
});

test("detects an N+1 with every repetition attributed to one line", async () => {
  const db = instrumentDrizzle(fakeDrizzle());
  configure({ threshold: 5 });

  // Hold the finding by reference: `count` keeps rising until the scope
  // closes, so copying it at trigger time would read the threshold, not the
  // total.
  const findings: Finding[] = [];
  configure({ onFinding: (f) => findings.push(f) });

  await runInScope("GET /orders", async () => {
    for (let i = 0; i < 8; i++) {
      await db.select().from("items").where(i);
    }
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.type, "n_plus_one");
  assert.equal(findings[0]!.count, 8);
  assert.ok(findings[0]!.callsite !== undefined, "the finding must name a line");
});

test("does not disturb the values the query returns", async () => {
  const db = instrumentDrizzle(fakeDrizzle());

  const rows = await runInScope("values", async () => db.select().from("t"));
  assert.deepEqual(rows, [{ id: 1 }]);
});

test("chaining that returns this keeps working", async () => {
  const db = instrumentDrizzle(fakeDrizzle());

  await runInScope("chain", async (scope) => {
    // Each of these returns `this`; the proxy must hand back the wrapper so the
    // chain does not silently fall back to the unwrapped builder.
    await db.select().from("t").where("a").limit(10);
    assert.equal(scope.queries.length, 1);
    assert.ok(scope.queries[0]?.callsite !== undefined);
  });
});

test("rejects anything that is not an object", () => {
  assert.throws(
    () => instrumentDrizzle(null as never),
    /expected the database returned by drizzle/,
  );
});
