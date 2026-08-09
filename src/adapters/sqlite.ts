/**
 * Adapters for SQLite — `better-sqlite3` and the built-in `node:sqlite`.
 *
 * SQLite drivers are statement-oriented rather than connection-oriented: the
 * SQL is fixed when you `prepare()`, and each `run`/`get`/`all`/`iterate` on
 * the resulting statement is one execution. So the interesting methods live on
 * the *statement* prototype, which we reach through the first prepared
 * statement and patch once.
 *
 * Conveniently both drivers expose their own text — `stmt.source` in
 * better-sqlite3, `stmt.sourceSQL` in node:sqlite — so no bookkeeping is
 * needed to map a statement back to its SQL.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import {
  combineRestores,
  disabled,
  observe,
  patchMethod,
  unpatchMethod,
  type AnyFn,
} from "./shared.js";

/** Statement methods that actually execute the query. */
const STATEMENT_METHODS = ["run", "get", "all", "iterate"] as const;

/** Database methods that run SQL without a prepared statement. */
const DATABASE_METHODS = ["exec", "pragma"] as const;

interface DatabaseClass {
  prototype: Record<string, any>;
}

function sourceOf(statement: unknown): string | undefined {
  if (typeof statement !== "object" || statement === null) return undefined;
  const candidate =
    (statement as { source?: unknown }).source ??
    (statement as { sourceSQL?: unknown }).sourceSQL;
  return typeof candidate === "string" ? candidate : undefined;
}

function wrapStatementMethod(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const sql = sourceOf(this);
    if (sql === undefined) return original.apply(this, args);

    return observe(
      { sql, params: args.length > 0 ? args : undefined },
      () => original.apply(this, args),
    );
  };
}

function wrapDatabaseMethod(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const [first] = args;
    if (typeof first !== "string") return original.apply(this, args);

    return observe({ sql: first }, () => original.apply(this, args));
  };
}

/**
 * Patches `prepare` so the first prepared statement reveals its prototype,
 * which is where the executing methods live. The statement prototype is shared
 * across every database instance of that driver, so this happens once.
 */
function instrumentPrepare(databasePrototype: Record<string, any>): () => void {
  const restores: (() => void)[] = [];
  let statementsPatched = false;

  patchMethod(databasePrototype, "prepare", (original) =>
    function patchedPrepare(this: unknown, ...args: unknown[]): unknown {
      const statement = original.apply(this, args);

      if (!statementsPatched && typeof statement === "object" && statement !== null) {
        statementsPatched = true;
        const statementPrototype = Object.getPrototypeOf(statement) as Record<string, any>;
        for (const method of STATEMENT_METHODS) {
          if (patchMethod(statementPrototype, method, wrapStatementMethod)) {
            restores.push(() => {
              unpatchMethod(statementPrototype, method);
            });
          }
        }
      }

      return statement;
    },
  );

  restores.push(() => {
    unpatchMethod(databasePrototype, "prepare");
  });

  return combineRestores(restores);
}

function instrumentDatabasePrototype(prototype: Record<string, any>): () => void {
  const restores: (() => void)[] = [instrumentPrepare(prototype)];

  for (const method of DATABASE_METHODS) {
    if (patchMethod(prototype, method, wrapDatabaseMethod)) {
      restores.push(() => {
        unpatchMethod(prototype, method);
      });
    }
  }

  return combineRestores(restores);
}

/**
 * Instruments `better-sqlite3`.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * import { instrumentBetterSqlite3 } from "nplusone/sqlite";
 *
 * instrumentBetterSqlite3(Database);
 * ```
 *
 * Pass the `Database` class itself, not an instance.
 */
export function instrumentBetterSqlite3(Database: DatabaseClass): () => void {
  if (typeof Database !== "function" && Database?.prototype === undefined) {
    throw new TypeError(
      "instrumentBetterSqlite3() expected the Database class exported by better-sqlite3.",
    );
  }
  return instrumentDatabasePrototype(Database.prototype);
}

interface NodeSqliteModule {
  DatabaseSync?: DatabaseClass;
}

/**
 * Instruments the built-in `node:sqlite` module (Node 22+).
 *
 * ```ts
 * import * as sqlite from "node:sqlite";
 * import { instrumentNodeSqlite } from "nplusone/sqlite";
 *
 * instrumentNodeSqlite(sqlite);
 * ```
 *
 * Accepts either the module or the `DatabaseSync` class.
 */
export function instrumentNodeSqlite(
  sqliteModule: NodeSqliteModule | DatabaseClass,
): () => void {
  const DatabaseSync =
    (sqliteModule as NodeSqliteModule).DatabaseSync ?? (sqliteModule as DatabaseClass);

  if (DatabaseSync?.prototype === undefined) {
    throw new TypeError(
      "instrumentNodeSqlite() expected the node:sqlite module or its DatabaseSync class.",
    );
  }

  return instrumentDatabasePrototype(DatabaseSync.prototype);
}

/**
 * Instruments a single open database.
 *
 * Note that statement methods live on a prototype shared by every database of
 * that driver, so patching one instance necessarily observes the others too.
 * Use the class-level functions unless you have a reason not to.
 */
export function instrumentSqliteDatabase(database: object): () => void {
  const prototype = Object.getPrototypeOf(database) as Record<string, any>;
  return instrumentDatabasePrototype(prototype);
}
