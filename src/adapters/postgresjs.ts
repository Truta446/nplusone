/**
 * Adapter for `postgres` (porsager/postgres, a.k.a. postgres.js).
 *
 * This driver is a tagged template function rather than an object with a
 * `query` method, so there is no prototype to patch — we wrap the `sql`
 * function in a proxy instead.
 *
 * The subtlety is that postgres.js is lazy and compositional. A call like
 *
 *     sql`SELECT * FROM t WHERE ${sql`a = 1`}`
 *
 * invokes the tag twice, but only one query reaches the database; the inner
 * call is a fragment. Recording at call time would count fragments as queries
 * and invent N+1s that do not exist. So instead we record when the query is
 * actually awaited — fragments are never awaited on their own.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import { record } from "../scope.js";
import { captureNow, disabled } from "./shared.js";
import type { CallSite } from "../callsite.js";

/** Marks a query whose `then` we already wrapped. */
const INSTRUMENTED = Symbol.for("nplusone.postgresjs.instrumented");

type Thenable = {
  then: (onFulfilled?: unknown, onRejected?: unknown) => unknown;
  [INSTRUMENTED]?: boolean;
};

function isTemplateStrings(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && "raw" in value;
}

function isThenable(value: unknown): value is Thenable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Defers recording until the query is awaited, so unexecuted fragments are not
 * counted. The call site is captured eagerly, because by the time `then` runs
 * the application frame has left the stack.
 */
function instrumentQuery(
  query: unknown,
  sql: string,
  params: readonly unknown[],
  callsite: CallSite | undefined,
): unknown {
  if (!isThenable(query) || query[INSTRUMENTED] === true) return query;

  const originalThen = query.then.bind(query);
  let recorded = false;

  const commit = (started: number, quiet: boolean): void => {
    try {
      record({ sql, params, callsite, durationMs: performance.now() - started });
    } catch (error) {
      if (!quiet) throw error;
      // A failing query already has an error on its way to the caller.
    }
  };

  Object.defineProperty(query, INSTRUMENTED, { value: true, enumerable: false });
  Object.defineProperty(query, "then", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function patchedThen(onFulfilled?: unknown, onRejected?: unknown): unknown {
      // Awaiting twice must not count twice.
      if (recorded) return originalThen(onFulfilled, onRejected);
      recorded = true;

      const started = performance.now();
      return originalThen(
        (value: unknown) => {
          commit(started, false);
          return typeof onFulfilled === "function" ? onFulfilled(value) : value;
        },
        (error: unknown) => {
          commit(started, true);
          if (typeof onRejected === "function") return onRejected(error);
          throw error;
        },
      );
    },
  });

  return query;
}

/**
 * Rebuilds the statement shape from the template chunks. The interpolated
 * values become `?`, which is exactly what the normalizer would do to them.
 */
function textOf(strings: TemplateStringsArray): string {
  return strings.join("?");
}

/**
 * Wraps a postgres.js `sql` instance.
 *
 * ```ts
 * import postgres from "postgres";
 * import { instrumentPostgresJs } from "nplusone/postgresjs";
 *
 * export const sql = instrumentPostgresJs(postgres(process.env.DATABASE_URL));
 * ```
 *
 * Like the Prisma adapter, this returns a **new** instance rather than patching
 * in place — `sql` is a function, not an object with methods to replace. Use
 * the returned value.
 */
export function instrumentPostgresJs<T extends (...args: any[]) => any>(sql: T): T {
  if (typeof sql !== "function") {
    throw new TypeError(
      "instrumentPostgresJs() expected the sql function returned by postgres().",
    );
  }

  return new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      if (disabled()) return Reflect.apply(target, thisArg, args);

      const [first, ...values] = args;

      // Not a tagged template: `sql(tableName)`, `sql(objectForInsert)`, and
      // friends build fragments rather than queries.
      if (!isTemplateStrings(first)) {
        return Reflect.apply(target, thisArg, args);
      }

      const callsite = captureNow();
      const query = Reflect.apply(target, thisArg, args);
      return instrumentQuery(query, textOf(first), values, callsite);
    },

    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);

      // `sql.unsafe(text, params)` runs raw SQL and is worth watching too.
      if (property === "unsafe" && typeof value === "function") {
        return function unsafe(this: unknown, ...args: unknown[]): unknown {
          if (disabled()) return (value as (...a: unknown[]) => unknown).apply(target, args);

          const [text, params] = args;
          if (typeof text !== "string") {
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          }

          const callsite = captureNow();
          const query = (value as (...a: unknown[]) => unknown).apply(target, args);
          return instrumentQuery(
            query,
            text,
            Array.isArray(params) ? params : [],
            callsite,
          );
        };
      }

      return value;
    },
  }) as T;
}
