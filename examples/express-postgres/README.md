Here is the full README.md file to copy and paste:
Markdown
Copy
Code
Preview

# Express + PostgreSQL N+1 Example

Demonstrates `nplusone` detecting an N+1 query in a real Express + Postgres app.

## Setup

```bash
docker compose up -d
node seed.mjs
node server.mjs

Endpoints
GET /orders/slow — intentionally triggers N+1 (one query per order).
Console shows: N+1 query 10× SELECT * FROM order_items WHERE order_id = ?

GET /orders/fast — fixed with a single batched query (order_id = ANY($1)).
Console shows no warning.


Test
bash
node test/index.test.mjs
slow endpoint triggers N+1 — passes by catching the thrown assertion
fast endpoint has no N+1 — passes silently with no N+1 detected
Expected Output
bash
curl localhost:3000/orders/slow  # → N+1 warning in server logs
curl localhost:3000/orders/fast  # → no warning
Notes
instrumentPg(pg) patches Client.prototype once, so pooled queries are not double-counted.
nplusoneMiddleware() creates one scope per HTTP request.
```
