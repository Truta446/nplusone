# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-08-21

### Fixed

- **libSQL queries inside `transaction()` and `executeMultiple()` were invisible**
  (#22, closes #15). The adapter patched only the client's `execute` / `batch`.
  A `transaction()` object has its own copies of those methods, so an N+1 inside
  a write transaction looked like a clean bill of health — measured against a
  real client, six queries issued and zero recorded. `transaction()` now wraps
  `execute` / `batch` on the object it resolves to, and `commit` / `rollback`
  stay untouched. `executeMultiple` is recorded as one statement — the whole
  script — because splitting on `;` is wrong inside string literals and trigger
  bodies.

  Thanks to @snowyukitty for the contribution, and for the detail that a quicker
  fix would have missed: a transaction is patched without retaining a restore
  closure for it, because keeping one per transaction would pin every completed
  transaction for the life of the process. The wrappers go quiet after `restore()`
  instead.

### Added

- **`sampleValues`** — show the values that differed on an N+1 (#19), so a
  finding can be reproduced and a loop over ten rows can be told from a loop
  over ten thousand:

  ```
    N+1 query  50× SELECT * FROM order_items WHERE order_id = ?
       at src/routes/orders.ts:38  (loadOrders)
       values: [1], [2], [3], [4], [5] … and 45 more
  ```

  **Off by default, and not because of noise.** Parameters are exactly where
  email addresses, tokens and personal data live, and this report goes to stderr
  and from there into CI logs. Everything else the reporter prints is either your
  own source location or SQL whose literals are already `?`. This is the only
  option that puts real data in the output, so turning it on should be a decision
  you make rather than one an upgrade makes for you.

  Values are truncated, and never attached to a duplicate finding — its
  parameters are identical by definition, so a sample of them says nothing.

- **`npm run bench`** (#16) — the cost of detection, as a number instead of a
  claim the README had been making unmeasured:

  ```
  node v24 · 20,000 queries × 9 samples (median)

    detector disabled                    20 ns/query            —
    captureStack: false                1488 ns/query     +1468 ns
    captureStack: true (default)      12476 ns/query    +12456 ns
    captureStack, stackDepth: 8        9869 ns/query     +9849 ns
    instrumentDrizzle, 4-call chain   48579 ns/query    +48559 ns
  ```

  Attribution is about 90% of what the detector costs, and `instrumentDrizzle`
  pays it four times over because the 0.6.0 fix for #12 captures on every chained
  call. Both were true before this release; now they are visible. #23 tracks
  bringing them down, including a measurement showing the obvious optimisation
  is worth about a third rather than the order of magnitude it is usually
  credited with.

### Changed

- **Kysely needs no adapter, and the README now says so with the measurement
  behind it** (closes #2). The issue assumed Kysely would fail the way Drizzle
  does. Measured against Kysely 0.29 on both a synchronous driver (`node:sqlite`)
  and an asynchronous one (`pg`), the reported line was correct in every shape
  tried — inline loop, helper-built query, `executeTakeFirst`, raw `sql` template,
  and inside a transaction — including the helper-built case Drizzle gets wrong.

  The reason is structural rather than lucky: a Kysely builder is not a thenable,
  so `.execute()` is called by your code and V8's async stack traces keep that
  frame. Drizzle's `.then()` is called by the runtime from a microtask, and there
  is no frame to keep.

  Rather than close the issue on a claim, `test/kysely.test.ts` pins it against
  a real Kysely, so a future version that defers execution differently fails the
  suite instead of quietly making the README wrong. `kysely` is a devDependency
  now; the package still has zero runtime dependencies.

- Two stale numbers in the README corrected, both found by running the command
  printed next to them: the package is 68 kB packed rather than 29 kB, and the
  test count is 177 rather than 156. Unverified numbers rot, which is most of
  the argument for #16 existing at all.


## [0.6.0] — 2026-08-13

### Fixed

- **Attribution named the wrong line when a query was built and executed in
  different places** (#12). The Drizzle adapter captured the call site at the
  *first* call in the chain, which is correct only when the query is built where
  it runs. It usually is not:

  ```ts
  function baseQuery() {
    return db.select().from(items);            // reported — shared by every caller
  }
  for (const order of orders) {
    await baseQuery().where(eq(items.orderId, order.id));   // the N+1 is here
  }
  ```

  Measured against the three shapes before the fix: a helper-built query was
  attributed to the helper, a reused builder to the line outside the loop, and
  only inline construction was right. The first two were **confidently wrong**,
  which is the worst failure mode for a tool like this — it sends someone to a
  file that is not the problem, with a line number that looks authoritative.

  Every chained call is now captured, and the one nearest execution wins:
  `.where()` above *is* called from the loop, synchronously, so the frame is
  there. The construction site is kept as `builtAt` and printed underneath when
  the two differ:

  ```
    N+1 query  10× SELECT * FROM order_items WHERE order_id = ?
       at src/routes/orders.ts:38  (loadOrders)
       built at src/repositories/items.ts:12  (baseQuery)
  ```

  It does not recover everything, and the README says so: if the whole chain
  lives inside the helper, no application frame anywhere names the loop. Keeping
  both origins is what makes that case honest instead of misleading.

  Raised by Mads Hansen in the comments of [the write-up](https://dev.to/truta446/your-orm-is-hiding-the-line-that-caused-the-slow-query-egm).

### Added

- **libSQL / Turso adapter** — `instrumentLibsql(client)` via `nplusone/libsql`
  (#13, closes #1). Records both call shapes `@libsql/client` accepts (a SQL
  string and a `{ sql, args }` object, positional or named), and records each
  statement of a `batch()` separately — a batch is one round trip but several
  statements, and collapsing it into one would hide exactly the N+1 a batch
  loop produces.

  Thanks to @milekv for the contribution.

  One change on merge: the statements in a batch were each wrapped in their own
  timing, which nests them, so every outer timer contained all the inner ones —
  a batch of six reported roughly five times the time it actually took, and one
  of fifty would report twenty-five. Drivers give no per-statement timing for a
  batch, so the round trip is now divided evenly: each statement's duration is
  an estimate, and the sum, which is what a finding reports, is the measurement.

- **`maxQueries`** — a per-scope query budget (#3). Not every expensive request
  repeats itself: running the detector against a real admin API turned up a
  route issuing fourteen *different* statements to load one record, and the
  detector said nothing, because nothing repeated.

  ```ts
  configure({ maxQueries: 10 });
  ```

  ```
  nplusone 1 finding in GET /dashboard — 8 queries, 9ms

    Query budget  8 queries in one scope (limit 6)
       7.2ms spent querying
       1× SELECT count(*) FROM orders
       1× SELECT count(*) FROM order_items
       …
  ```

  Two deliberate choices. It prints **no call site**, because there is no single
  line to blame — a breakdown of where the budget went is the honest answer, and
  picking an arbitrary frame would not be. And it **never throws**, whatever
  `mode` says: the check runs when the scope closes, which for a request is a
  `finally` block or a `finish` handler, where throwing would replace a real
  error or crash the process. `expectQueryCount()` remains the way to fail a
  test on a budget.

  Off by default, so upgrading adds no new output.

- `Finding.builtAt`, `Finding.breakdown` and `RecordedQuery.builtAt`.
- `runWithOrigin()`, `ambientOrigin()` and the `QueryOrigin` type are exported,
  so an adapter for an ORM this package does not ship can publish both origins.
  `runWithCallSite()` still works and is unchanged in meaning.

### Changed

- `expectNoNPlusOne({ includeDuplicates: true })` no longer fails on a budget
  finding. Its name promises one thing, and failing for a different reason
  would be a confusing way to learn about a new option.
- The README's coverage figure was stale — it claimed 96% lines and 95%
  functions; the command beside it reports 80% and 75%. Corrected rather than
  quietly dropped.

## [0.5.1] — 2026-08-10

### Changed

- The colour helpers in `report.ts` read the environment on every call instead
  of once at import. Behaviour is unchanged; the point is that the coloured
  paths can now be tested at all. Branch coverage there went from ~62% to ~97%,
  covering `NO_COLOR`, `TERM=dumb`, non-TTY (the CI case) and TTY.

  Thanks to @blut-agent for the contribution (#7, closes #4).

## [0.5.0] — 2026-08-10

### Added

- **`autoScope`** — an opt-in mode that groups queries arriving with no scope
  into an inferred one, closed after a short idle gap. Missing the scoping step
  was the most likely way to conclude the library did not work: it recorded
  nothing and printed a single warning. Now a first run shows something.

  It is a heuristic and says so — concurrent requests can land in the same
  inferred group, and every report from one is labelled as inferred. Off by
  default; CI and real measurement still want a real scope.

  Two details worth knowing. The idle timer is `unref`'d, so it can never hold a
  process open. That alone would mean a short script exits before the window
  elapses and prints nothing, so an inferred scope is also flushed on
  `beforeExit`.

- `flushAutoScope()` closes an inferred scope immediately.
- `ScopeSummary.inferred` distinguishes a guessed window from a real one.

## [0.4.0] — 2026-08-09

Everything in this release came out of running the detector against real
applications rather than test fixtures.

### Fixed

- **Queries were silently dropped under Next.js.** Bundlers duplicate modules:
  Next compiles each route handler into its own bundle, so a route could end up
  with a second copy of this library. The copy that patched the driver held one
  `AsyncLocalStorage` and the copy that opened the request scope held another,
  and neither could see the other — the scope opened, the queries ran, and the
  detector reported zero. All shared state now lives in a process-wide registry
  keyed with `Symbol.for`, so every copy resolves to the same object. This also
  covers Jest module isolation and monorepos that hoist two versions.

- **Transaction control was reported as duplicated work.** An ORM opens one
  transaction per write, so a handler doing three saves emitted three identical
  `START TRANSACTION` and three identical `COMMIT` statements. Against a real
  login endpoint these were the *only* two findings, burying anything real.
  `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `SET` and friends are now
  classified as `control` and excluded by default; set
  `includeTransactionControl: true` to count them.

### Added

- `ScopeSummary.queries` — the statements recorded in a scope, so a custom
  reporter can explain a request that is expensive without anything repeating.
- A custom `reporter` now receives **every** scope, including clean ones. Query
  counts per request are useful on their own, and only the caller knows whether
  to surface them. The built-in reporter still only prints when there are
  findings.

## [0.3.0] — 2026-08-09

### Added

- **Drizzle adapter** (`nplusone/drizzle`) for call site attribution. Drizzle
  queries were detected through the driver but reported with no call site: a
  Drizzle query is a lazy thenable, so execution is triggered by the runtime
  calling `.then()`, and by then the stack holds twelve frames of which none
  belong to the application. The adapter captures the call site during the
  synchronous building phase and republishes it while the query runs.
- **postgres.js adapter** (`nplusone/postgresjs`). Recording is deferred until
  the query is awaited, because the driver is compositional — ``sql`WHERE
  ${sql`a = 1`}` `` invokes the tag twice but runs one statement, and counting
  fragments would invent N+1s that do not exist.
- **MongoDB adapter** (`nplusone/mongodb`), which also covers Mongoose.
- Release workflow now verifies the version is new before building, since npm
  versions are immutable.

## [0.2.0] — 2026-08-09

### Added

- Adapters for `mysql2`, `better-sqlite3` and `node:sqlite`.
- Prisma adapter (`nplusone/prisma`). Prisma does not use the Node drivers at
  all — it talks to the database through its own query engine — so
  driver-level instrumentation cannot see it.
- `./package.json` is exposed in `exports` for tooling that reads it.

## [0.1.0] — 2026-08-09

Initial release.

- Detects N+1 and duplicate queries at runtime by instrumenting the database
  driver, so Drizzle, Knex, TypeORM, MikroORM, Sequelize and raw SQL are all
  covered without needing their own adapters.
- Reports the file and line that issued the repeated query.
- Request scoping for Express/Connect and fetch-style frameworks.
- Test helpers (`expectNoNPlusOne`, `expectQueryCount`) so a finding becomes a
  CI regression gate.

[0.7.0]: https://github.com/Truta446/nplusone/releases/tag/v0.7.0
[0.6.0]: https://github.com/Truta446/nplusone/releases/tag/v0.6.0
[0.5.1]: https://github.com/Truta446/nplusone/releases/tag/v0.5.1
[0.5.0]: https://github.com/Truta446/nplusone/releases/tag/v0.5.0
[0.4.0]: https://github.com/Truta446/nplusone/releases/tag/v0.4.0
[0.3.0]: https://github.com/Truta446/nplusone/releases/tag/v0.3.0
[0.2.0]: https://github.com/Truta446/nplusone/releases/tag/v0.2.0
[0.1.0]: https://github.com/Truta446/nplusone/releases/tag/v0.1.0
