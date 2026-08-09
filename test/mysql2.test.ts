import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import {
  instrumentMysql2,
  instrumentMysql2Connection,
} from "../src/adapters/mysql2.js";

/**
 * Mirrors mysql2's connection: `query` and `execute`, each accepting either a
 * callback or returning a promise, and both string and `{ sql, values }` forms.
 */
class FakeConnection {
  calls = 0;

  query(sql: unknown, values?: unknown, callback?: unknown): unknown {
    return this.#run(sql, values, callback);
  }

  execute(sql: unknown, values?: unknown, callback?: unknown): unknown {
    return this.#run(sql, values, callback);
  }

  #run(_sql: unknown, values?: unknown, callback?: unknown): unknown {
    this.calls++;
    const rows = [{ id: 1 }];
    const cb = typeof values === "function" ? values : callback;
    if (typeof cb === "function") {
      setImmediate(() => (cb as (e: unknown, r: unknown) => void)(null, rows));
      return { emitter: true };
    }
    return Promise.resolve([rows, []]);
  }
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("detects an N+1 through the promise API", async () => {
  const restore = instrumentMysql2({ Connection: FakeConnection });
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  const conn = new FakeConnection();
  await runInScope("GET /orders", async () => {
    for (let i = 0; i < 7; i++) {
      await conn.query("SELECT * FROM items WHERE order_id = ?", [i]);
    }
  });

  restore();
  assert.equal(conn.calls, 7, "the real query still ran");
  const nPlusOnes = findings.filter((f) => f.type === "n_plus_one");
  assert.equal(nPlusOnes.length, 1);
  assert.equal(nPlusOnes[0]!.count, 7);
  assert.equal(nPlusOnes[0]!.normalized, "SELECT * FROM items WHERE order_id = ?");
});

test("instruments execute as well as query", async () => {
  const restore = instrumentMysql2({ Connection: FakeConnection });
  const findings: Finding[] = [];
  configure({ threshold: 4, onFinding: (f) => findings.push(f) });

  const conn = new FakeConnection();
  await runInScope("prepared", async () => {
    for (let i = 0; i < 5; i++) {
      await conn.execute("SELECT * FROM items WHERE order_id = ?", [i]);
    }
  });

  restore();
  assert.equal(findings.filter((f) => f.type === "n_plus_one").length, 1);
});

test("records callback-style queries", async () => {
  const restore = instrumentMysql2Connection(new FakeConnection() as never);
  const conn = new FakeConnection();
  const restore2 = instrumentMysql2Connection(conn as never);
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("callback", async (scope) => {
    await new Promise<void>((resolve) => {
      conn.query("SELECT * FROM items WHERE order_id = ?", [1], () => resolve());
    });
    count = scope.queryCount;
  });

  restore2();
  restore();
  assert.equal(count, 1);
});

test("accepts the { sql, values } form", async () => {
  const conn = new FakeConnection();
  const restore = instrumentMysql2Connection(conn as never);
  configure({ threshold: 1000 });

  let recorded = "";
  await runInScope("options-form", async (scope) => {
    await conn.query({ sql: "SELECT * FROM t WHERE id = ?", values: [3] });
    recorded = scope.queries[0]?.normalized ?? "";
  });

  restore();
  assert.equal(recorded, "SELECT * FROM t WHERE id = ?");
});

test("does not count a pooled query twice", async () => {
  // mysql2's Pool.query delegates to a connection. Only the connection is
  // patched, so one logical query records once.
  class FakePool {
    constructor(private readonly conn: FakeConnection) {}
    query(sql: string, values?: unknown[]): unknown {
      return this.conn.query(sql, values);
    }
  }

  const restore = instrumentMysql2({ Connection: FakeConnection });
  const conn = new FakeConnection();
  const pool = new FakePool(conn);
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("pool", async (scope) => {
    await pool.query("SELECT 1", []);
    count = scope.queryCount;
  });

  restore();
  assert.equal(count, 1);
});

test("rejects a module without Connection", () => {
  assert.throws(() => instrumentMysql2({}), /expected the mysql2 module/);
});
