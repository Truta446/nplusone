import pg from "pg";

const client = new pg.Client({
  connectionString: "postgres://demo:demo@localhost:5433/nplusone_demo",
});

await client.connect();

await client.query(`
  DROP TABLE IF EXISTS order_items;
  DROP TABLE IF EXISTS orders;

  CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT now()
  );

  CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(id),
    name TEXT NOT NULL,
    price NUMERIC NOT NULL
  );
`);

for (let i = 0; i < 10; i++) {
  const { rows } = await client.query(
    "INSERT INTO orders (user_id) VALUES ($1) RETURNING id",
    [42],
  );
  const orderId = rows[0].id;

  // 6+ items per order so it exceeds the library's threshold of 5
  for (let j = 0; j < 6; j++) {
    await client.query(
      "INSERT INTO order_items (order_id, name, price) VALUES ($1, $2, $3)",
      [orderId, `item-${j}`, (Math.random() * 50).toFixed(2)],
    );
  }
}

console.log("Seeded 10 orders with 6 items each.");
await client.end();