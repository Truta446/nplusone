/**
 * A Kysely dialect over `node:sqlite`, for the Kysely attribution tests.
 *
 * Kysely's own SQLite dialect wants `better-sqlite3`, a native module. This
 * keeps the dependency to one pure-JS package and the driver to the one Node
 * already ships — which is also the one `instrumentNodeSqlite` patches.
 *
 * It lives in its own file for a reason that is part of what the tests check.
 * A real dialect is library code inside `node_modules`, so `captureCallSite`
 * skips its frames. Written inline in the test file it would be the nearest
 * application frame instead, and every finding would be attributed to it —
 * the tests would fail for a reason that has nothing to do with Kysely. The
 * tests pass `ignoreCallSites` for this path to put it back where it belongs.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from "kysely";

/** Frames from this file are library frames, as far as attribution goes. */
export const DIALECT_FRAMES = /kysely-dialect/;

function control(sql: string): CompiledQuery {
  return { sql, parameters: [], query: undefined as never, queryId: undefined as never };
}

export function nodeSqliteDialect(database: DatabaseSync): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const statement = database.prepare(compiled.sql);
      const parameters = compiled.parameters as never[];
      if (/^\s*select/i.test(compiled.sql)) {
        return { rows: statement.all(...parameters) as R[] };
      }
      statement.run(...parameters);
      return { rows: [] };
    },
    // Declared, never used. Not a generator: one with no `yield` in it is a
    // lint error, and an unreachable `yield` to satisfy the rule would be
    // noise. Throwing satisfies the return type on its own.
    streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("streaming is not part of this test dialect");
    },
  };

  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction(conn) {
      await conn.executeQuery(control("BEGIN"));
    },
    async commitTransaction(conn) {
      await conn.executeQuery(control("COMMIT"));
    },
    async rollbackTransaction(conn) {
      await conn.executeQuery(control("ROLLBACK"));
    },
    async releaseConnection() {},
    async destroy() {},
  };

  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => driver,
    createIntrospector: (db: Kysely<never>) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}
