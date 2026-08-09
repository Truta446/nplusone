# Contributing

Thanks for looking. The most useful contribution is usually **an adapter for a
driver we do not cover yet** — they are around 100 lines each and share the
helpers in `src/adapters/shared.ts`.

## Getting set up

```sh
npm install
npm test          # 114 tests, including real queries against node:sqlite
npm run coverage  # coverage report
npm run typecheck
```

No database is needed: the integration tests use `node:sqlite`, which ships
with Node.

## Writing an adapter

Start from an existing one — `src/adapters/pg.ts` is the simplest. An adapter
does three things:

1. **Find the method that executes a query** and replace it with `patchMethod`.
   Patch as close to the driver as possible; anything built on top comes along
   for free, which is why one `pg` adapter covers Drizzle, Knex, TypeORM,
   MikroORM, Sequelize and Kysely at once.
2. **Capture the call site at the boundary**, before the driver takes over.
   `observe()` does this for you. By the time a promise settles, the frame that
   issued the query is gone from the stack.
3. **Avoid double counting.** If a pool delegates to a client, patch only one of
   them.

Two traps worth knowing, both learned the hard way:

- **Lazy ORMs lose the stack.** If queries execute from a thenable rather than
  from a call your user makes, no stack walk will find the application frame.
  That is what `src/adapters/drizzle.ts` and the ambient call site mechanism in
  `src/callsite-context.ts` exist for.
- **Bundlers duplicate modules.** Shared state must go through
  `src/global-state.ts`, never a module-level variable, or a second copy of the
  library will quietly see none of the first copy's scopes.

## Tests

Every adapter needs tests, and they can run without the real driver — a
faithful stand-in is fine, as long as it mirrors the driver's actual call
shapes (callback *and* promise forms, config-object arguments, pooled
delegation). See `test/mysql2.test.ts`.

Prefer tests that assert on the thing that would actually break. For the
Drizzle adapter, that is *which line* gets reported, not merely that something
was recorded.

## Style

- Comments explain **why**, not what. If the code is self-explanatory, write
  nothing.
- No new runtime dependencies. Zero-dependency is a feature.
- The public API is documented with JSDoc; keep it accurate.

## Reporting a bug

A reproduction beats a description. If you can, include the driver and version,
how you scope requests, and the output you got versus what you expected.
