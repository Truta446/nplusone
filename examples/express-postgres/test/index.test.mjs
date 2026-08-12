import { test } from "node:test";
import assert from "node:assert";
import pg from "pg";
import { configure } from "../../../dist/index.js";
import { instrumentPg } from "../../../dist/adapters/pg.js";
import { expectNoNPlusOne } from "../../../dist/test.js";

instrumentPg(pg);
configure({ threshold: 5, duplicateThreshold: 2 });

const db = new pg.Client({
  connectionString: "postgres://demo:demo@localhost:5433/nplusone_demo",
});
await db.connect();

test("slow endpoint triggers N+1", async () => {
  let threw = false;
  try {
    await expectNoNPlusOne(async () => {
      const { rows: orders } = await db.query(
        "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
        [42],
      );
      for (const order of orders) {
        await db.query("SELECT * FROM order_items WHERE order_id = $1", [order.id]);
      }
    }, { name: "slow endpoint" });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.name, "NPlusOneAssertionError");
  }
  assert.ok(threw, "Expected N+1 to be detected and throw");
});

test("fast endpoint has no N+1", async () => {
  await expectNoNPlusOne(async () => {
    const { rows: orders } = await db.query(
      "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
      [42],
    );
    const orderIds = orders.map((o) => o.id);
    await db.query("SELECT * FROM order_items WHERE order_id = ANY($1)", [orderIds]);
  }, { name: "fast endpoint" });
});

test("closes the connection", async () => {
  // Without this the client keeps the event loop alive and `node
  // test/index.test.mjs` never exits.
  await db.end();
});
