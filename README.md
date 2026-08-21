<div align="center">

<img src="https://raw.githubusercontent.com/Truta446/nplusone/main/assets/banner.png" alt="nplusone — catch N+1 queries in Node.js at runtime, and fail your CI before they reach production" width="880">

# nplusone

[![npm version](https://img.shields.io/npm/v/nplusone?style=flat-square&color=cb3837)](https://www.npmjs.com/package/nplusone)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022%20%7C%2024-339933?style=flat-square)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-success?style=flat-square)](./package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/Truta446/nplusone/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Truta446/nplusone/actions)

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
<tr><td>🪶</td><td><b>Zero runtime dependencies.</b> 68 kB packed.</td></tr>
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

Tested on Node **18, 20, 22 and 24**.

The package is ESM. `import` works on every version above; `require()` works
from Node 20.19 onwards, which is where Node backported requiring an ES module.
On Node 18 — end-of-life since April 2025 — use `import`.

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
| **PostgreSQL** (`postgres.js`) | `instrumentPostgresJs(sql)` | ✅ |
| **MySQL / MariaDB** (`mysql2`) | `instrumentMysql2(mysql)` | ✅ |
| **SQLite** (`better-sqlite3`) | `instrumentBetterSqlite3(Database)` | ✅ |
| **SQLite** (`node:sqlite`) | `instrumentNodeSqlite(sqlite)` | ✅ |
| **libSQL / Turso** (`@libsql/client`) | `instrumentLibsql(client)` | ✅ |
| **MongoDB** | `instrumentMongodb(mongodb)` | ✅ |
| **Prisma** | `instrumentPrisma(client)` | ✅ |
| **Drizzle** | driver **+** `instrumentDrizzle(db)` | ✅ |
| **Knex** | via its driver | ✅ |
| **TypeORM** | via its driver | ✅ |
| **MikroORM** | via its driver (Knex) | ✅ |
| **Sequelize** | via its driver | ✅ |
| **Kysely** | via its driver — [no adapter needed](#why-kysely-needs-no-adapter) | ✅ |
| **Mongoose** | via the MongoDB driver | ✅ |
| Anything else | [10 lines with `record()`](#other-drivers) | 🔧 |

> **Two exceptions worth knowing about.**
>
> **Prisma** does not use `pg` or `mysql2` at all — it talks to the database through its own query engine, so driver-level instrumentation cannot see it. Hence a dedicated adapter.
>
> **Drizzle** *is* detected through its driver, but without attribution. A Drizzle query is a lazy thenable, so the execution is triggered by the runtime calling `.then()` — measured against Drizzle 0.45, the stack at that point holds twelve frames and not one of them belongs to your code. Adding `instrumentDrizzle(db)` captures the call site while the query is still being built, and the driver adapter uses it. Use both together: the driver reports the SQL, Drizzle reports the line.

### Why Kysely needs no adapter

Kysely looks like it should have the same problem as Drizzle, and it does not. Measured against Kysely 0.29 on a synchronous driver (`node:sqlite`) and an asynchronous one (`pg`), the reported line was correct in every shape tried — an inline loop, a helper-built query, `executeTakeFirst`, a raw `sql` template tag, and inside a transaction. Including the helper-built case that Drizzle gets wrong:

```ts
function baseQuery() {
  return db.selectFrom("items").selectAll();
}
for (const order of orders) {
  await baseQuery().where("order_id", "=", order.id).execute();   // <- correctly blamed
}
```

The reason is structural rather than lucky. A Kysely builder is **not** a thenable: nothing runs until you call `.execute()` yourself, and V8's async stack traces keep the frame that awaited it. Drizzle's `.then()` is called by the runtime from a microtask, so there is no such frame to keep.

That is a claim about a library this one does not control, so `test/kysely.test.ts` pins it: if a future Kysely defers execution differently, the suite fails rather than the README quietly becoming wrong.

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

**libSQL / Turso**:

```ts
import { createClient } from "@libsql/client";
import { instrumentLibsql } from "nplusone/libsql";

const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
instrumentLibsql(client);
```

**Drizzle** — pair it with the driver adapter. Returns a *new* db, so use the returned one:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { instrumentDrizzle } from "nplusone/drizzle";

instrumentPostgresJs(sql);                                  // reports the SQL
export const db = instrumentDrizzle(drizzle(sql, { schema })); // reports the line
```

Construction and execution are not always the same place. When a repository helper builds the query and a route runs it in a loop, the loop is what you need to see — so the adapter keeps **both** origins and reports the one nearest to execution:

```
  N+1 query  10× SELECT * FROM order_items WHERE order_id = ?
     at src/routes/orders.ts:38  (loadOrders)
     built at src/repositories/items.ts:12  (baseQuery)
```

The `built at` line only appears when it says something the first line does not.

**postgres.js** — returns a *new* `sql`, since it is a function rather than an object. Use the returned one:

```ts
import postgres from "postgres";
import { instrumentPostgresJs } from "nplusone/postgresjs";

export const sql = instrumentPostgresJs(postgres(process.env.DATABASE_URL));
```

**MongoDB** — also covers Mongoose, which uses this driver underneath:

```ts
import * as mongodb from "mongodb";
import { instrumentMongodb } from "nplusone/mongodb";

instrumentMongodb(mongodb);
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

**Just trying it out?** `autoScope` groups queries that arrive with no scope,
closing the group after a short idle gap — so you see something on the first run
without wiring anything:

```ts
configure({ autoScope: true });
```

It is a **heuristic**, and off by default for that reason: concurrent requests
can land in the same inferred group and inflate the counts. The report says so
whenever a scope was inferred. For numbers you can trust, and for CI, open a
real scope.

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
| **Query budget** | The scope issued more than `maxQueries` statements, whatever they were | Look at the breakdown — usually a layer fetching more than the page needs |

Counting raw repetitions would flag a query that runs ten times with the *same* argument as an N+1. It isn't one — that's a caching problem with a different fix. So the N+1 rule counts **distinct parameter sets**, and when a driver interpolates values straight into the SQL, the statement text itself acts as the discriminator.

Statements are normalized before comparison, so `WHERE id = 42` and `WHERE id = 43` are one shape. The normalizer is a scanner rather than a pile of regexes, because literals need context: `--` inside a string is not a comment, the `2` in `col2` is not a number, and `::text` is a cast rather than a placeholder.

### Requests that are slow without repeating

Not every expensive endpoint has an N+1 in it. Running the detector against a real admin API turned up a route that issued **fourteen different statements** to load one record — nothing repeated, so nothing was reported. `maxQueries` covers that case:

```ts
configure({ maxQueries: 10 });
```

```
nplusone 1 finding in GET /dashboard — 8 queries, 9ms

  Query budget  8 queries in one scope (limit 6)
     7.2ms spent querying
     1× SELECT count(*) FROM orders
     1× SELECT count(*) FROM order_items
     1× SELECT * FROM orders ORDER BY created_at DESC LIMIT ?
     …
```

It prints no call site, because there isn't one to print — the total is the finding, not any single line. The breakdown is there instead, ordered by count, so you can see where the budget went.

It is **off by default** and it never throws, whatever `mode` says: the check runs when the scope closes, which for a request means a `finally` block or a `finish` handler, and throwing from there would replace a real error or take the process down. To fail a test on a budget, use [`expectQueryCount()`](#guarding-it-in-ci).

### Seeing which values varied

A finding names the shape, the count and the line. `sampleValues` adds the values, which is how you tell a loop over ten rows from a loop over ten thousand, and how you reproduce it in a console:

```ts
configure({ sampleValues: 5 });
```

```
  N+1 query  50× SELECT * FROM order_items WHERE order_id = ?
     at src/routes/orders.ts:38  (loadOrders)
     values: [1], [2], [3], [4], [5] … and 45 more
```

**Off by default, and this one is not about noise.** Parameters are exactly where email addresses, tokens and personal data live, and this report goes to stderr and from there into CI logs. Everything else the reporter prints is either your own source location or SQL whose literals are already replaced by `?`. This is the only option that puts real data in the output, so turning it on should be your decision rather than an upgrade's.

Values are truncated, and never shown for a duplicate finding — its parameters are identical by definition, so a sample of them says nothing.

## Configuration

```ts
configure({
  threshold: 5,            // distinct repetitions before it counts as N+1
  duplicateThreshold: 2,   // identical repetitions before it counts as duplicate
  mode: "warn",            // "warn" | "throw" | "silent"
  statements: ["select"],  // restrict to certain statement kinds
  ignore: [/pg_catalog/],  // skip queries matching these
  captureStack: true,      // attribute queries to a line of code
  maxQueries: 10,          // report a scope over this many queries (off by default)
  sampleValues: 5,         // show up to 5 differing values on an N+1 (off by default)
  autoScope: false,        // group unscoped queries heuristically (see above)
  autoScopeIdleMs: 50,     // idle gap that ends an inferred scope
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

**Contributions very welcome** — the adapters in [`src/adapters/`](./src/adapters) are around 100 lines each and share the helpers in `shared.ts`.

```sh
npm test          # 177 tests, including real queries against node:sqlite
npm run coverage  # 80% lines, 83% branches
```

## Cost

The real expense is capturing a stack trace per query. That used to be an assertion; `npm run bench` makes it a number:

```
node v24 · 20,000 queries × 9 samples (median)

  detector disabled                    20 ns/query            —   the floor
  captureStack: false                1488 ns/query     +1468 ns   detection without attribution
  captureStack: true (default)      12476 ns/query    +12456 ns   stackDepth 30, the shipped default
  captureStack, stackDepth: 8        9869 ns/query     +9849 ns   a shallower walk
  instrumentDrizzle, 4-call chain   48579 ns/query    +48559 ns   one capture per chained call
```

Read the gaps, not the absolutes — those move with hardware and Node version. Three things worth taking from it:

- **Attribution is ~90% of the cost.** Turning it off with `captureStack: false` keeps detection and makes the detector roughly eight times cheaper — cheap enough to leave running in staging.
- **`instrumentDrizzle` costs about four times a plain query**, because fixing attribution for helper-built queries ([#12](https://github.com/Truta446/nplusone/issues/12)) means capturing on every chained call rather than once. That is the price of a correct line number for Drizzle, it is paid in development only, and [#23](https://github.com/Truta446/nplusone/issues/23) is about bringing it down.
- **Even the default is ~12µs per query.** A request issuing fifty queries pays under a millisecond. That is invisible in development and is why the detector is disabled when `NODE_ENV === "production"` unless you explicitly enable it.

Scopes retain up to 10,000 queries each; past that, counting continues but individual queries stop being kept, so a long-lived scope cannot grow without bound.

## Limitations

Worth knowing before you file an issue:

- **Queries with no application frame on the stack** — a lazy ORM executing from its own internals, or a pool issuing queries from a background task — are grouped by statement shape alone and reported as `<unknown call site>`. For Drizzle this is exactly what `nplusone/drizzle` fixes; for an ORM without an adapter yet, the finding still tells you which statement is looping.
- **A fully encapsulated query builder** still reports the helper. If the whole chain lives inside `function q(id) { return db.select().from(items).where(eq(items.id, id)) }`, every building call happens in the helper and no application frame anywhere names the loop. The finding is accurate about the statement; the line is the closest one that exists.
- **A legitimate batch loop** (a script importing rows one at a time) looks exactly like an N+1 from the driver's point of view. Use `statements: ["select"]` or `ignore` to quiet it.
- **Cursors and streaming queries** (`pg.Cursor`, `pg-query-stream`) carry no statement text at the patch point and are not recorded.
- **`AsyncLocalStorage` is required** for scope propagation. Code that breaks async context will report queries outside any scope, and you get one warning saying so.
- **Prisma and MongoDB report operations, not SQL** (`User.findUnique`, `users.findOne`) — that's the call you would batch, so it's the more actionable label, but it is not the raw statement.
- **MongoDB cursors** (`find`, `aggregate`) are recorded when the cursor is created rather than when it is drained, so no duration is reported for them.

## Verified against real applications

Not just unit tests. Each release is run against real stacks, and the last one
found three bugs that fixtures never would have:

- **Next.js bundling** gives a route its own copy of the library, so the scope
  and the driver ended up on two different `AsyncLocalStorage` instances and
  nothing was detected. Shared state is now process-global.
- **Transaction control** (`BEGIN`/`COMMIT`) was reported as duplicated work,
  burying real findings under ORM bookkeeping.
- **Lazy ORMs** execute from a thenable, so the caller's frame is gone by the
  time the driver runs. Hence `nplusone/drizzle`.

## Contributors

This library is better than one person could have made it. Thank you:

| | Contribution |
| --- | --- |
| [@snowyukitty](https://github.com/snowyukitty) | **Made libSQL transactions visible** ([#22](https://github.com/Truta446/nplusone/pull/22)) — queries inside `transaction()` were being recorded nowhere at all, which reads as a clean bill of health |
| [@milekv](https://github.com/milekv) | The **libSQL / Turso adapter** ([#13](https://github.com/Truta446/nplusone/pull/13)) — including the decision to record each `batch()` statement separately, which is what keeps a batch loop from hiding an N+1 |
| [@TarekHassan1](https://github.com/TarekHassan1) | The **runnable Express + PostgreSQL example** ([#11](https://github.com/Truta446/nplusone/pull/11)) — `docker compose up`, hit two endpoints, see the difference |
| [@blut-agent](https://github.com/blut-agent) | **Made the report's colour handling testable** ([#7](https://github.com/Truta446/nplusone/pull/7)) and covered every path — `NO_COLOR`, `TERM=dumb`, non-TTY and TTY |
| [Mads Hansen](https://dev.to/madsstoumann) | Spotted that attribution names the wrong line when a query is built in one place and executed in another ([#12](https://github.com/Truta446/nplusone/issues/12)) — the bug behind the 0.6.0 fix |

### Want to be on this list?

There are [good first issues](https://github.com/Truta446/nplusone/labels/good%20first%20issue) open right now, and [`CONTRIBUTING.md`](./CONTRIBUTING.md) walks through writing an adapter — they are about 100 lines each and share the helpers in `shared.ts`.

Two things worth knowing before you start:

- **Measure before you theorise.** Nearly every real bug in this library was found by dumping the actual stack or running against a real database, and several plausible theories died that way. If an issue asks you to post a measurement, that measurement is valuable even if you stop there.
- **Say what you chose and why.** Most of these decisions are trade-offs rather than right answers. A PR that explains the reasoning gets reviewed faster than one that hides it.

## License

MIT
