<div align="center">

# nplusone

### Catch N+1 queries in Node.js at runtime — and fail your CI before they reach production.

[![npm version](https://img.shields.io/npm/v/nplusone.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/nplusone)
[![license](https://img.shields.io/npm/l/nplusone.svg?style=flat-square&color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/nplusone.svg?style=flat-square&color=339933)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-success?style=flat-square)](./package.json)

Ruby has [bullet](https://github.com/flyerhzm/bullet). Python has [nplusone](https://pypi.org/project/nplusone/).<br/>
Node has had to make do with squinting at query logs. **This is that tool.**

</div>

---

```
nplusone 2 findings in GET /orders — 10 queries, 14ms

  N+1 query  7× SELECT * FROM order_items WHERE order_id = ?
     at src/routes/orders.ts:47:38  (loadOrdersPage)
     9.3ms spent here

  Duplicate query  2× SELECT * FROM settings WHERE user_id = ?
     at src/lib/settings.ts:32:29  (loadSettings)
     2.4ms spent here
     identical parameters — the repeats returned the same rows
```

<table>
<tr><td>🔌</td><td><b>Works with your ORM, whatever it is.</b> It watches the database driver, not the abstraction on top.</td></tr>
<tr><td>📍</td><td><b>Points at your code.</b> Not "51 queries ran" — <i>this line ran 50 of them</i>.</td></tr>
<tr><td>🧪</td><td><b>CI gate.</b> <code>expectNoNPlusOne()</code> turns a debugging session into a regression test.</td></tr>
<tr><td>🪶</td><td><b>Zero runtime dependencies.</b> 29 kB packed.</td></tr>
<tr><td>🔒</td><td><b>Off in production by default</b>, so nobody pays for stack capture by accident.</td></tr>
</table>

## The bug it finds

```ts
const orders = await db.query("SELECT * FROM orders WHERE user_id = $1", [userId]);

for (const order of orders) {
  order.items = await db.query("SELECT * FROM items WHERE order_id = $1", [order.id]);
}
```

Fifty orders, fifty-one queries.

It is invisible in development against a seeded database with three rows, and it is the single most common reason a page that felt instant in review takes four seconds in production.

## Install

```sh
npm install --save-dev nplusone
```

## Quick start

Two lines at boot, one middleware:

```ts
import pg from "pg";
import { configure } from "nplusone";
import { instrumentPg } from "nplusone/pg";
import { nplusoneMiddleware } from "nplusone/http";

configure({ threshold: 5 });
instrumentPg(pg);

app.use(nplusoneMiddleware());
```

That is it. Hit a page, and anything suspicious prints to stderr with the line that caused it.

## Compatibility

Because the detector hooks the **driver**, every query builder and ORM on top of that driver is covered without needing its own adapter.

| Your stack | Setup | |
| --- | --- | :--: |
| **PostgreSQL** (`pg`) | `instrumentPg(pg)` | ✅ |
| **MySQL / MariaDB** (`mysql2`) | `instrumentMysql2(mysql)` | ✅ |
| **SQLite** (`better-sqlite3`) | `instrumentBetterSqlite3(Database)` | ✅ |
| **SQLite** (`node:sqlite`) | `instrumentNodeSqlite(sqlite)` | ✅ |
| **Prisma** | `instrumentPrisma(client)` | ✅ |
| **Drizzle** | via its driver | ✅ |
| **Knex** | via its driver | ✅ |
| **TypeORM** | via its driver | ✅ |
| **MikroORM** | via its driver (Knex) | ✅ |
| **Sequelize** | via its driver | ✅ |
| **Kysely** | via its driver | ✅ |
| **postgres.js**, **MongoDB**, anything else | [10 lines with `record()`](#other-drivers) | 🔧 |

> **Prisma is the exception worth knowing about.** By default it does not use `pg` or `mysql2` at all — it talks to the database through its own query engine, so driver-level instrumentation cannot see it. That is why it gets a dedicated adapter.

<details>
<summary><b>Setup for each driver</b></summary>

**PostgreSQL** — covers Drizzle, Knex, TypeORM, MikroORM, Sequelize, Kysely, raw SQL:

```ts
import pg from "pg";
import { instrumentPg } from "nplusone/pg";

instrumentPg(pg);
```

**MySQL / MariaDB** — also covers `mysql2/promise`:

```ts
import mysql from "mysql2";
import { instrumentMysql2 } from "nplusone/mysql2";

instrumentMysql2(mysql);
```

**SQLite**:

```ts
import Database from "better-sqlite3";
import { instrumentBetterSqlite3 } from "nplusone/sqlite";

instrumentBetterSqlite3(Database);
```

```ts
import * as sqlite from "node:sqlite";
import { instrumentNodeSqlite } from "nplusone/sqlite";

instrumentNodeSqlite(sqlite);
```

**Prisma** — note that this returns a *new* client, because Prisma clients are immutable. Use the returned one:

```ts
import { PrismaClient } from "@prisma/client";
import { instrumentPrisma } from "nplusone/prisma";

export const prisma = instrumentPrisma(new PrismaClient());
```

</details>

## Scoping requests

A **scope** is the window in which repetition is suspicious — one request, one job, one test. Running the same statement a thousand times a day is normal; running it fifty times while serving one page is not.

**Express / Connect / NestJS:**

```ts
import { nplusoneMiddleware } from "nplusone/http";

app.use(nplusoneMiddleware());
```

**Hono, Next.js route handlers, Bun, Deno, Cloudflare Workers:**

```ts
import { withRequestScope } from "nplusone/http";

export const GET = withRequestScope(async (request) => {
  return Response.json(await loadOrders());
});
```

**Background jobs, scripts, anything else:**

```ts
import { runInScope } from "nplusone";

await runInScope("nightly-report", () => generateReport());
```

## Guarding it in CI

This is the part that keeps the bug from coming back.

```ts
import { expectNoNPlusOne, expectQueryCount } from "nplusone/test";

test("orders page does not N+1", async () => {
  await expectNoNPlusOne(() => loadOrdersPage(userId));
});

test("dashboard stays within its query budget", async () => {
  await expectQueryCount(() => renderDashboard(userId), 4);
});
```

A failure names the line:

```
Expected no N+1 queries in orders page, found 1:

  N+1 query  50× SELECT * FROM items WHERE order_id = ?
     at src/pages/orders.ts:47:38  (loadOrdersPage)
```

The helpers work whether or not the detector is enabled globally, and restore your configuration afterwards. They throw a plain `Error`, so **Jest, Vitest and `node:test` all report them correctly** with no plugin.

## How it decides

Inside a scope, two different problems get reported — and keeping them apart is the whole trick:

| Finding | What it means | How you fix it |
| --- | --- | --- |
| **N+1 query** | One statement shape ran from one line with ≥ `threshold` **different** values | Batch it — `WHERE id = ANY($1)`, a join, or a DataLoader |
| **Duplicate query** | A byte-identical statement with identical parameters ran ≥ `duplicateThreshold` times | Cache it, or hoist it out of the loop |

Counting raw repetitions would flag a query that runs ten times with the *same* argument as an N+1. It isn't one — that's a caching problem with a different fix. So the N+1 rule counts **distinct parameter sets**, and when a driver interpolates values straight into the SQL, the statement text itself acts as the discriminator.

Statements are normalized before comparison, so `WHERE id = 42` and `WHERE id = 43` are one shape. The normalizer is a scanner rather than a pile of regexes, because literals need context: `--` inside a string is not a comment, the `2` in `col2` is not a number, and `::text` is a cast rather than a placeholder.

## Configuration

```ts
configure({
  threshold: 5,            // distinct repetitions before it counts as N+1
  duplicateThreshold: 2,   // identical repetitions before it counts as duplicate
  mode: "warn",            // "warn" | "throw" | "silent"
  statements: ["select"],  // restrict to certain statement kinds
  ignore: [/pg_catalog/],  // skip queries matching these
  captureStack: true,      // attribute queries to a line of code
  onFinding: (f) => metrics.increment("n_plus_one", { scope: f.scope }),
  reporter: (summary) => logger.warn(summary),
  enabled: process.env.NODE_ENV !== "production",  // the default
});
```

`mode: "throw"` raises an `NPlusOneError` at the query that crosses the threshold — useful in staging when you want the failure to be loud.

## Other drivers

`record()` is public API, so any driver takes a few lines:

```ts
import { record } from "nplusone";

const original = driver.execute;
driver.execute = async function (sql, params) {
  const started = performance.now();
  try {
    return await original.call(this, sql, params);
  } finally {
    record({ sql, params, durationMs: performance.now() - started });
  }
};
```

Adapters for `postgres.js` and MongoDB are on the list. **Contributions very welcome** — the existing adapters in [`src/adapters/`](./src/adapters) are 100 lines each and share the helpers in `shared.ts`.

## Cost

The real expense is capturing a stack trace per query, which is why the detector is disabled when `NODE_ENV === "production"` unless you explicitly enable it. Set `captureStack: false` to keep detection while dropping the "which line" attribution — cheap enough to leave running in staging.

Scopes retain up to 10,000 queries each; past that, counting continues but individual queries stop being kept, so a long-lived scope cannot grow without bound.

## Limitations

Worth knowing before you file an issue:

- **Queries with no application frame on the stack** — some pools issue queries from a background task with no user code below them — are grouped by statement shape alone and reported as `<unknown call site>`.
- **A legitimate batch loop** (a script importing rows one at a time) looks exactly like an N+1 from the driver's point of view. Use `statements: ["select"]` or `ignore` to quiet it.
- **Cursors and streaming queries** (`pg.Cursor`, `pg-query-stream`) carry no statement text at the patch point and are not recorded.
- **`AsyncLocalStorage` is required** for scope propagation. Code that breaks async context will report queries outside any scope, and you get one warning saying so.
- **Prisma reports operations, not SQL** (`User.findUnique` rather than the generated query) — that's the call you would batch, so it's the more actionable label, but it is not the raw statement.

## License

MIT
