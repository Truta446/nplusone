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
import { originNow } from "../src/adapters/shared.js";
import { instrumentDrizzle } from "../src/adapters/drizzle.js";

/**
 * Mimics Drizzle's shape: lazy thenables, chained builders that return `this`,
 * and a builder-to-builder transition (`insert().values()`).
 *
 * `then` stands in for the driver adapter — it reads the origin and records it
 * exactly the way `observe()` does in the real pg/postgres.js adapters. Keeping
 * that faithful matters: a fake that only forwards the call site would pass
 * while the two-origin plumbing was broken.
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
          const origin = originNow();
          record({
            sql: this.sql,
            params: this.#params,
            callsite: origin.callsite,
            builtAt: origin.builtAt,
          });
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
    transaction: async (callback: (tx: { select: () => Builder }) => unknown) =>
      callback({ select: () => new Builder("select * from t") }),
  };
}

/** The builder type, so a test helper can return one without a cast. */
type Chain = ReturnType<ReturnType<typeof fakeDrizzle>["select"]>;

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

/**
 * Regression tests for #12 — construction and execution in different places.
 *
 * Before the fix these three reported the line that *built* the query, which
 * for a shared repository helper is the one line guaranteed to be innocent.
 * A wrong line number is worse than no line number, so these assert on which
 * function is named rather than merely that something was named.
 *
 * Everything asserts on `callsite.function`, never on a line number: line
 * numbers move whenever this file is edited.
 */

test("attributes an N+1 to the loop, not to the helper that built the query", async () => {
  const db = instrumentDrizzle(fakeDrizzle());
  configure({ threshold: 3 });

  function baseQuery(): Chain {
    return db.select().from("items");
  }
  async function theLoop(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      // `.where()` is called from here, synchronously — this frame exists.
      await baseQuery().where(i);
    }
  }

  await runInScope("helper-built", async (scope) => {
    await theLoop();
    const finding = scope.findings[0];
    assert.equal(finding?.type, "n_plus_one");
    assert.match(
      finding?.callsite?.function ?? "",
      /theLoop/,
      "the loop is where the N+1 lives",
    );
    assert.match(
      finding?.builtAt?.function ?? "",
      /baseQuery/,
      "the construction site is kept, not discarded",
    );
  });
});

test("attributes a reused builder to the loop that reuses it", async () => {
  const db = instrumentDrizzle(fakeDrizzle());
  configure({ threshold: 3 });

  function buildOnce(): Chain {
    return db.select().from("items");
  }
  async function reuseIt(query: Chain): Promise<void> {
    for (let i = 0; i < 4; i++) await query.where(i);
  }

  await runInScope("reused", async (scope) => {
    // The builder returns `this`, so every iteration refines the same object —
    // the only way to notice the loop is to update the origin in place.
    await reuseIt(buildOnce());
    assert.match(scope.findings[0]?.callsite?.function ?? "", /reuseIt/);
    assert.match(scope.findings[0]?.builtAt?.function ?? "", /buildOnce/);
  });
});

test("drops the construction site when it says nothing new", async () => {
  const db = instrumentDrizzle(fakeDrizzle());

  await runInScope("inline", async (scope) => {
    // Built and executed on one line. Reporting two origins a column apart
    // would be noise dressed as precision.
    await db.select().from("t").where(1);
    assert.ok(scope.queries[0]?.callsite !== undefined);
    assert.equal(scope.queries[0]?.builtAt, undefined);
  });
});

test("nested scopes each get their own attribution", async () => {
  const db = instrumentDrizzle(fakeDrizzle());
  configure({ threshold: 3 });

  async function outerLoop(): Promise<void> {
    for (let i = 0; i < 4; i++) await db.select().from("a").where(i);
  }
  async function innerLoop(): Promise<void> {
    for (let i = 0; i < 4; i++) await db.select().from("b").where(i);
  }

  await runInScope("outer", async (outer) => {
    await outerLoop();
    await runInScope("inner", async (inner) => {
      await innerLoop();
      assert.equal(inner.findings.length, 1);
      assert.match(inner.findings[0]?.callsite?.function ?? "", /innerLoop/);
    });
    assert.equal(outer.findings.length, 1);
    assert.match(outer.findings[0]?.callsite?.function ?? "", /outerLoop/);
  });
});

test("concurrent scopes cannot borrow each other's attribution", async () => {
  const db = instrumentDrizzle(fakeDrizzle());
  configure({ threshold: 3 });

  // Both requests build through the *same* helper, so the construction site is
  // identical and only the execution site tells them apart. If the origin
  // leaked between them, one of these assertions names the other's loop.
  function sharedBase(): Chain {
    return db.select().from("items");
  }
  async function loopA(): Promise<void> {
    for (let i = 0; i < 4; i++) await sharedBase().where(i);
  }
  async function loopB(): Promise<void> {
    for (let i = 0; i < 4; i++) await sharedBase().where(i);
  }

  const [a, b] = await Promise.all([
    runInScope("A", async (scope) => {
      await loopA();
      return scope;
    }),
    runInScope("B", async (scope) => {
      await loopB();
      return scope;
    }),
  ]);

  assert.match(a.findings[0]?.callsite?.function ?? "", /loopA/);
  assert.match(b.findings[0]?.callsite?.function ?? "", /loopB/);
});

test("an insert built through a transition keeps both origins", async () => {
  const db = instrumentDrizzle(fakeDrizzle());
  configure({ threshold: 3 });

  // `insert()` returns one object and `.values()` another, so the origin has
  // to survive a builder-to-builder hand-off as well as a chain.
  function buildInsert(): Chain {
    return db.insert("items").values({ id: 1 });
  }
  async function insertLoop(): Promise<void> {
    for (let i = 0; i < 4; i++) await buildInsert().where(i);
  }

  await runInScope("inserts", async (scope) => {
    await insertLoop();
    assert.match(scope.findings[0]?.callsite?.function ?? "", /insertLoop/);
    assert.match(scope.findings[0]?.builtAt?.function ?? "", /buildInsert/);
  });
});

test("attributes queries inside a transaction to the loop", async () => {
  const db = instrumentDrizzle(fakeDrizzle());
  configure({ threshold: 3 });

  await runInScope("tx-loop", async (scope) => {
    await db.transaction(async (tx) => {
      async function txLoop(): Promise<void> {
        for (let i = 0; i < 4; i++) await tx.select().where(i);
      }
      await txLoop();
      assert.match(scope.findings[0]?.callsite?.function ?? "", /txLoop/);
    });
  });
});

test("keeps working when stack capture is switched off", async () => {
  const db = instrumentDrizzle(fakeDrizzle());
  configure({ threshold: 3, captureStack: false });

  await runInScope("no-stacks", async (scope) => {
    for (let i = 0; i < 4; i++) await db.select().from("items").where(i);
    // Detection must survive without attribution — that is the whole point of
    // the option, and the chained capture must not resurrect the cost.
    assert.equal(scope.findings.length, 1);
    assert.equal(scope.queries[0]?.callsite, undefined);
    assert.equal(scope.queries[0]?.builtAt, undefined);
  });
});
