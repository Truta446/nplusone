/**
 * Adapter for `mysql2` (MySQL and MariaDB).
 *
 * Both `query` (text protocol) and `execute` (prepared statements) go through
 * `Connection.prototype`, and the promise wrapper in `mysql2/promise` delegates
 * to that same base connection — so patching the prototype covers the callback
 * API, the promise API, and pooled connections in one go.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import { record } from "../scope.js";
import {
  captureNow,
  combineRestores,
  disabled,
  observe,
  patchMethod,
  unpatchMethod,
  type AnyFn,
} from "./shared.js";

interface Queryable {
  query(...args: any[]): any;
  execute?(...args: any[]): any;
}

interface Mysql2Module {
  Connection?: { prototype: Queryable };
}

interface Extracted {
  sql: string;
  params: readonly unknown[] | undefined;
}

function extract(args: readonly unknown[]): Extracted | undefined {
  const [first, second] = args;

  if (typeof first === "string") {
    return { sql: first, params: Array.isArray(second) ? second : undefined };
  }

  // { sql, values } — also covers the options-object form with timeout, etc.
  if (typeof first === "object" && first !== null) {
    const config = first as { sql?: unknown; values?: unknown };
    if (typeof config.sql === "string") {
      const values = Array.isArray(config.values)
        ? config.values
        : Array.isArray(second)
          ? second
          : undefined;
      return { sql: config.sql, params: values };
    }
  }

  return undefined;
}

function wrap(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const extracted = extract(args);
    if (extracted === undefined) return original.apply(this, args);

    const observation = { sql: extracted.sql, params: extracted.params };

    // Callback form returns a Query emitter, not a promise.
    const last = args[args.length - 1];
    if (typeof last === "function") {
      const callback = last as AnyFn;
      const callsite = captureNow();
      const started = performance.now();

      const forwarded = args.slice(0, -1);
      forwarded.push(function (this: unknown, ...cbArgs: unknown[]) {
        try {
          record({
            sql: observation.sql,
            params: observation.params,
            callsite,
            durationMs: performance.now() - started,
          });
        } catch (detectorError) {
          // Inside the driver's callback — re-raise out of band rather than
          // unwinding through mysql2's internals.
          queueMicrotask(() => {
            throw detectorError;
          });
        }
        return callback.apply(this, cbArgs);
      });

      return original.apply(this, forwarded);
    }

    return observe(observation, () => original.apply(this, args));
  };
}

/**
 * Instruments the `mysql2` module.
 *
 * ```ts
 * import mysql from "mysql2";
 * import { instrumentMysql2 } from "nplusone/mysql2";
 *
 * instrumentMysql2(mysql);
 * ```
 *
 * This also covers `mysql2/promise`, which wraps the same connection class.
 * Call it once, before creating connections or pools.
 */
export function instrumentMysql2(mysql2Module: Mysql2Module): () => void {
  if (mysql2Module.Connection === undefined) {
    throw new TypeError(
      "instrumentMysql2() expected the mysql2 module (with a Connection export). " +
        "Pass a connection or pool to instrumentMysql2Connection() instead.",
    );
  }

  const target = mysql2Module.Connection.prototype as unknown as Record<string, any>;
  // Pool.query delegates to a connection, so only the connection is patched —
  // otherwise every pooled query would be counted twice.
  patchMethod(target, "query", wrap);
  patchMethod(target, "execute", wrap);

  return combineRestores([
    () => {
      unpatchMethod(target, "query");
    },
    () => {
      unpatchMethod(target, "execute");
    },
  ]);
}

/**
 * Instruments a single connection or pool rather than the whole module.
 *
 * Note that patching a *pool* records queries at the pool boundary; if the
 * module is also instrumented, prefer one or the other.
 */
export function instrumentMysql2Connection<T extends Queryable>(connection: T): () => void {
  const target = connection as unknown as Record<string, any>;
  patchMethod(target, "query", wrap);
  patchMethod(target, "execute", wrap);
  return combineRestores([
    () => {
      unpatchMethod(target, "query");
    },
    () => {
      unpatchMethod(target, "execute");
    },
  ]);
}
