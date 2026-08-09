/**
 * A stand-in for a real app: an orders page that loads items in a loop, plus a
 * settings lookup that runs twice. Uses the pg adapter against a fake client so
 * the example runs without a database.
 *
 *   npm run build && node examples/demo.mjs
 */

import { configure } from "../dist/index.js";
import { instrumentPgClient } from "../dist/adapters/pg.js";
import { withRequestScope } from "../dist/http.js";

// --- a fake pg client -------------------------------------------------------

const ORDERS = [101, 102, 103, 104, 105, 106, 107];

class FakeClient {
  async query(text, values) {
    await new Promise((r) => setTimeout(r, 1));
    if (text.includes("FROM orders")) return { rows: ORDERS.map((id) => ({ id })) };
    return { rows: [{ ok: true }] };
  }
}

const db = new FakeClient();
instrumentPgClient(db);
configure({ threshold: 5, duplicateThreshold: 2 });

// --- the application code ---------------------------------------------------

async function loadSettings(userId) {
  const { rows } = await db.query("SELECT * FROM settings WHERE user_id = $1", [userId]);
  return rows[0];
}

async function loadOrdersPage(userId) {
  await loadSettings(userId);

  const { rows: orders } = await db.query(
    "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
    [userId],
  );

  const withItems = [];
  for (const order of orders) {
    // The bug: one query per order instead of a single batched lookup.
    const { rows: items } = await db.query(
      "SELECT * FROM order_items WHERE order_id = $1",
      [order.id],
    );
    withItems.push({ ...order, items });
  }

  // And this one was already loaded above.
  await loadSettings(userId);

  return withItems;
}

// --- run it inside a request scope -----------------------------------------

const handler = withRequestScope(async (request) => {
  const orders = await loadOrdersPage(42);
  return { status: 200, count: orders.length };
});

const result = await handler({ method: "GET", url: "http://localhost/orders" });
console.log("handler returned:", result);
