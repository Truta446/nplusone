# Express + PostgreSQL N+1 Example

Demonstrates `nplusone` detecting an N+1 query in a real Express + Postgres app.

## Setup

```bash
docker compose up -d
node seed.mjs
node server.mjs
```
## Test

```bash
node test/index.test.mjs