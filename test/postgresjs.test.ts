import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import { instrumentPostgresJs } from "../src/adapters/postgresjs.js";

/**
 * Stands in for postgres.js: a tagged template function returning a lazy,
 * thenable Query, plus an `unsafe` method.
 */
function fakePostgres() {
  const executed: string[] = [];

  function sql(strings: TemplateStringsArray | unknown, ...values: unknown[]): unknown {
    const text = Array.isArray(strings) ? strings.join("?") : String(strings);
    let promise: Promise<unknown> | undefined;

    // Lazy: nothing runs until the query is awaited.
    return {
      then(onFulfilled?: unknown, onRejected?: unknown) {
        promise ??= Promise.resolve().then(() => {
          executed.push(text);
          void values;
          return [{ id: 1 }];
        });
        return promise.then(onFulfilled as never, onRejected as never);
      },
    };
  }

  sql.unsafe = (text: string, _params?: unknown[]): unknown => ({
    then(onFulfilled?: unknown, onRejected?: unknown) {
      return Promise.resolve()
        .then(() => {
          executed.push(text);
          return [{ id: 1 }];
        })
        .then(onFulfilled as never, onRejected as never);
    },
  });

  return { sql, executed };
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("detects an N+1 through the tagged template", async () => {
  const { sql: raw, executed } = fakePostgres();
  const sql = instrumentPostgresJs(raw);
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  await runInScope("GET /orders", async () => {
    for (let i = 0; i < 7; i++) {
      await sql`SELECT * FROM items WHERE order_id = ${i}`;
    }
  });

  assert.equal(executed.length, 7, "the queries still ran");
  const nPlusOnes = findings.filter((f) => f.type === "n_plus_one");
  assert.equal(nPlusOnes.length, 1);
  assert.equal(nPlusOnes[0]!.count, 7);
  assert.equal(nPlusOnes[0]!.normalized, "SELECT * FROM items WHERE order_id = ?");
});

test("does not count an unawaited fragment as a query", async () => {
  // The whole reason recording is deferred to `then`: composing a query out of
  // fragments invokes the tag several times but only runs one statement.
  const { sql: raw } = fakePostgres();
  const sql = instrumentPostgresJs(raw);
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("fragments", async (scope) => {
    const where = sql`a = ${1}`;
    const order = sql`created_at DESC`;
    await sql`SELECT * FROM t WHERE ${where} ORDER BY ${order}`;
    count = scope.queryCount;
  });

  assert.equal(count, 1, "two fragments plus one query should record once");
});

test("awaiting the same query twice records it once", async () => {
  const { sql: raw } = fakePostgres();
  const sql = instrumentPostgresJs(raw);
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("double-await", async (scope) => {
    const query = sql`SELECT * FROM t WHERE id = ${1}`;
    await query;
    await query;
    count = scope.queryCount;
  });

  assert.equal(count, 1);
});

test("attributes the query to the calling line", async () => {
  const { sql: raw } = fakePostgres();
  const sql = instrumentPostgresJs(raw);
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });

  await runInScope("attribution", async () => {
    for (let i = 0; i < 4; i++) {
      await sql`SELECT * FROM items WHERE order_id = ${i}`;
    }
  });

  assert.match(findings[0]?.callsite?.file ?? "", /postgresjs\.test\./);
});

test("instruments sql.unsafe", async () => {
  const { sql: raw, executed } = fakePostgres();
  const sql = instrumentPostgresJs(raw) as typeof raw;
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });

  await runInScope("unsafe", async () => {
    for (let i = 0; i < 4; i++) {
      await sql.unsafe("SELECT * FROM items WHERE order_id = $1", [i]);
    }
  });

  assert.equal(executed.length, 4);
  assert.equal(findings.filter((f) => f.type === "n_plus_one").length, 1);
});

test("records a query that rejects", async () => {
  function failing(_strings: TemplateStringsArray, ..._values: unknown[]): unknown {
    return {
      then(_onFulfilled?: unknown, onRejected?: unknown) {
        return Promise.reject(new Error("connection lost")).then(
          undefined,
          onRejected as never,
        );
      },
      // postgres.js Query extends Promise, so `catch` routes through `then` —
      // which is the method the adapter patches. Mirroring that here proves
      // the instrumentation is not bypassed by `.catch()`.
      catch(this: { then: (f?: unknown, r?: unknown) => unknown }, onRejected?: unknown) {
        return this.then(undefined, onRejected);
      },
    };
  }

  const sql = instrumentPostgresJs(failing as never) as unknown as (
    s: TemplateStringsArray,
    ...v: unknown[]
  ) => Promise<unknown>;
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("failing", async (scope) => {
    for (let i = 0; i < 3; i++) {
      await (sql`SELECT * FROM t WHERE id = ${i}` as Promise<unknown>).catch(() => {});
    }
    count = scope.queryCount;
  });

  assert.equal(count, 3, "a failed query still costs a round trip");
});

test("leaves non-template calls alone", async () => {
  const { sql: raw } = fakePostgres();
  const sql = instrumentPostgresJs(raw) as unknown as (v: unknown) => unknown;
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("identifier", async (scope) => {
    // `sql(tableName)` builds an identifier fragment, not a query.
    sql("users");
    count = scope.queryCount;
  });

  assert.equal(count, 0);
});

test("rejects anything that is not a function", () => {
  assert.throws(
    () => instrumentPostgresJs({} as never),
    /expected the sql function/,
  );
});
