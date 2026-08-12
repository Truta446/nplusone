# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.5.1]: https://github.com/Truta446/nplusone/releases/tag/v0.5.1
[0.5.0]: https://github.com/Truta446/nplusone/releases/tag/v0.5.0
[0.4.0]: https://github.com/Truta446/nplusone/releases/tag/v0.4.0
[0.3.0]: https://github.com/Truta446/nplusone/releases/tag/v0.3.0
[0.2.0]: https://github.com/Truta446/nplusone/releases/tag/v0.2.0
[0.1.0]: https://github.com/Truta446/nplusone/releases/tag/v0.1.0
