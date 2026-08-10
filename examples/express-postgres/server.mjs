import express from "express";
import pg from "pg";
import { configure } from "../../dist/index.js";
import { instrumentPgClient } from "../../dist/adapters/pg.js";
import { withRequestScope } from "../../dist/http.js";

const db = new pg.Client({
  connectionString: "postgres://demo:demo@localhost:5433/nplusone_demo",
});
await db.connect();

instrumentPgClient(db);
configure({ threshold: 5, duplicateThreshold: 2 });

const app = express();

// The bug: one query per order (N+1 problem)
app.get("/orders/slow", async (req, res) => {
  const handler = withRequestScope(async ({ method, url }) => {
    const { rows: orders } = await db.query(
      "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
      [42],
    );

    const withItems = [];
    for (const order of orders) {
      const { rows: items } = await db.query(
        "SELECT * FROM order_items WHERE order_id = $1",
        [order.id],
      );
      withItems.push({ ...order, items });
    }

    res.json({ count: withItems.length });
  });

  await handler({ method: req.method, url: req.url });
});

// The fix: one batched query
app.get("/orders/fast", async (req, res) => {
  const handler = withRequestScope(async ({ method, url }) => {
    const { rows: orders } = await db.query(
      "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
      [42],
    );

    const orderIds = orders.map((o) => o.id);
    const { rows: items } = await db.query(
      "SELECT * FROM order_items WHERE order_id = ANY($1)",
      [orderIds],
    );

    const itemsByOrder = {};
    for (const item of items) {
      (itemsByOrder[item.order_id] ??= []).push(item);
    }

    const withItems = orders.map((o) => ({ ...o, items: itemsByOrder[o.id] || [] }));
    res.json({ count: withItems.length });
  });

  await handler({ method: req.method, url: req.url });
});

app.listen(3000, () => console.log("Listening on http://localhost:3000"));