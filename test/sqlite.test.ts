/**
 * Integration tests against a real database. `node:sqlite` is built into Node,
 * so these exercise the adapter end to end with no fakes and no service to
 * start — actual SQL, actual prepared statements, actual rows.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import {
  instrumentNodeSqlite,
  instrumentBetterSqlite3,
} from "../src/adapters/sqlite.js";

function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER)");
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, order_id INTEGER, name TEXT)");
  for (let orderId = 1; orderId <= 8; orderId++) {
    db.prepare("INSERT INTO orders (id, user_id) VALUES (?, ?)").run(orderId, 1);
    db.prepare("INSERT INTO items (order_id, name) VALUES (?, ?)").run(orderId, `item-${orderId}`);
  }
  return db;
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("detects a real N+1 against node:sqlite", async () => {
  const db = seed();
  const restore = instrumentNodeSqlite({ DatabaseSync });
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  const rows: unknown[] = [];
  await runInScope("GET /orders", () => {
    const orders = db.prepare("SELECT * FROM orders WHERE user_id = ?").all(1);
    for (const order of orders as { id: number }[]) {
      // The bug: one lookup per order.
      const items = db.prepare("SELECT * FROM items WHERE order_id = ?").all(order.id);
      rows.push(items);
    }
  });

  restore();
  db.close();

  assert.equal(rows.length, 8, "the queries still returned their rows");
  const nPlusOnes = findings.filter((f) => f.type === "n_plus_one");
  assert.equal(nPlusOnes.length, 1);
  assert.equal(nPlusOnes[0]!.count, 8);
  assert.equal(nPlusOnes[0]!.normalized, "SELECT * FROM items WHERE order_id = ?");
  assert.match(nPlusOnes[0]!.callsite?.file ?? "", /sqlite\.test\./);
});

test("a batched query against node:sqlite is clean", async () => {
  const db = seed();
  const restore = instrumentNodeSqlite({ DatabaseSync });
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  await runInScope("GET /orders", () => {
    db.prepare("SELECT * FROM orders WHERE user_id = ?").all(1);
    db.prepare("SELECT * FROM items WHERE order_id IN (1,2,3,4,5,6,7,8)").all();
  });

  restore();
  db.close();
  assert.deepEqual(findings, []);
});

test("records every executing statement method", async () => {
  const db = seed();
  const restore = instrumentNodeSqlite({ DatabaseSync });
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("methods", (scope) => {
    db.prepare("SELECT * FROM orders WHERE id = ?").get(1);
    db.prepare("SELECT * FROM orders").all();
    db.prepare("INSERT INTO orders (id, user_id) VALUES (?, ?)").run(99, 2);
    for (const _row of db.prepare("SELECT * FROM orders").iterate()) break;
    count = scope.queryCount;
  });

  restore();
  db.close();
  assert.equal(count, 4, "get, all, run and iterate should each record once");
});

test("records db.exec", async () => {
  const db = new DatabaseSync(":memory:");
  const restore = instrumentNodeSqlite({ DatabaseSync });
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("exec", (scope) => {
    db.exec("CREATE TABLE t (id INTEGER)");
    count = scope.queryCount;
  });

  restore();
  db.close();
  assert.equal(count, 1);
});

test("restoring stops the recording", async () => {
  const db = seed();
  const restore = instrumentNodeSqlite({ DatabaseSync });
  restore();
  configure({ threshold: 2 });

  let count = -1;
  await runInScope("after-restore", (scope) => {
    for (let i = 1; i <= 5; i++) {
      db.prepare("SELECT * FROM items WHERE order_id = ?").all(i);
    }
    count = scope.queryCount;
  });

  db.close();
  assert.equal(count, 0);
});

test("instrumenting twice does not double count", async () => {
  const db = seed();
  const restoreA = instrumentNodeSqlite({ DatabaseSync });
  const restoreB = instrumentNodeSqlite({ DatabaseSync });
  configure({ threshold: 1000 });

  let count = -1;
  await runInScope("double", (scope) => {
    db.prepare("SELECT * FROM orders WHERE id = ?").get(1);
    count = scope.queryCount;
  });

  restoreB();
  restoreA();
  db.close();
  assert.equal(count, 1);
});

// --- better-sqlite3, exercised through a faithful stand-in ------------------
//
// better-sqlite3 is a native addon; rather than require a compile step in CI,
// this mirrors its shape: a Database with prepare/exec/pragma, and statements
// that expose their SQL as `.source`.

class FakeStatement {
  constructor(readonly source: string) {}
  run(..._params: unknown[]): unknown {
    return { changes: 1 };
  }
  get(..._params: unknown[]): unknown {
    return { id: 1 };
  }
  all(..._params: unknown[]): unknown[] {
    return [{ id: 1 }];
  }
  *iterate(..._params: unknown[]): Generator<unknown> {
    yield { id: 1 };
  }
}

class FakeDatabase {
  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql);
  }
  exec(_sql: string): void {}
  pragma(_source: string): void {}
}

test("detects an N+1 through the better-sqlite3 shape", async () => {
  const restore = instrumentBetterSqlite3(FakeDatabase);
  const findings: Finding[] = [];
  configure({ threshold: 4, onFinding: (f) => findings.push(f) });

  const db = new FakeDatabase();
  await runInScope("better-sqlite3", () => {
    for (let i = 0; i < 6; i++) {
      db.prepare("SELECT * FROM items WHERE order_id = ?").get(i);
    }
  });

  restore();
  assert.equal(findings.filter((f) => f.type === "n_plus_one").length, 1);
  assert.equal(findings[0]!.normalized, "SELECT * FROM items WHERE order_id = ?");
});

test("reads statement SQL from .source", async () => {
  const restore = instrumentBetterSqlite3(FakeDatabase);
  configure({ threshold: 1000 });

  const db = new FakeDatabase();
  let captured = "";
  await runInScope("source", (scope) => {
    db.prepare("SELECT name FROM items WHERE id = ?").all(1);
    captured = scope.queries[0]?.sql ?? "";
  });

  restore();
  assert.equal(captured, "SELECT name FROM items WHERE id = ?");
});

test("rejects something that is not a database class", () => {
  assert.throws(
    () => instrumentNodeSqlite({} as never),
    /expected the node:sqlite module/,
  );
});
