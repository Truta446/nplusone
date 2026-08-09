/**
 * Adapter for `pg` (node-postgres).
 *
 * Patching `Client.prototype.query` covers every path into the database —
 * pooled clients, `pool.query`, and any query builder or ORM that uses `pg` as
 * its driver, because they all bottom out here.
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
  /**
   * Method syntax on purpose: parameter checking is bivariant for methods,
   * which is what lets a driver's concrete signature satisfy this shape.
   */
  query(...args: any[]): any;
}

interface PgModule {
  Client?: { prototype: Queryable };
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

  if (typeof first === "object" && first !== null) {
    const config = first as { text?: unknown; values?: unknown };
    if (typeof config.text === "string") {
      const values = Array.isArray(config.values)
        ? config.values
        : Array.isArray(second)
          ? second
          : undefined;
      return { sql: config.text, params: values };
    }
  }

  // Submittable (Cursor, QueryStream) — no statement text at this point.
  return undefined;
}

function wrapQuery(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const extracted = extract(args);
    if (extracted === undefined) return original.apply(this, args);

    const observation = { sql: extracted.sql, params: extracted.params };

    // Callback style: pg returns a Query emitter rather than a promise, so the
    // timing hangs off the callback instead.
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
          // We are inside the driver's own callback. Throwing here would
          // unwind through pg's internals and could leave a connection in a
          // bad state, so re-raise out of band: still an uncaught error that
          // fails the process, but not one that corrupts the driver.
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
 * Instruments the `pg` module so every query through it is observed.
 *
 * ```ts
 * import pg from "pg";
 * import { instrumentPg } from "nplusone/pg";
 *
 * instrumentPg(pg);
 * ```
 *
 * Call it once, before creating pools. Returns a function that undoes it.
 */
export function instrumentPg(pgModule: PgModule): () => void {
  if (pgModule.Client === undefined) {
    throw new TypeError(
      "instrumentPg() expected the pg module (with a Client export). " +
        "Pass a pool or client to instrumentPgClient() instead.",
    );
  }

  // Only the Client prototype. `Pool.query` acquires a client and delegates to
  // `client.query`, so patching both would record every pooled query twice.
  const target = pgModule.Client.prototype as unknown as Record<string, any>;
  patchMethod(target, "query", wrapQuery);

  return combineRestores([
    () => {
      unpatchMethod(target, "query");
    },
  ]);
}

/**
 * Instruments a single pool or client instead of the whole module. Useful when
 * you only want one connection watched, or when the module object is out of
 * reach.
 */
export function instrumentPgClient<T extends Queryable>(client: T): () => void {
  const target = client as unknown as Record<string, any>;
  patchMethod(target, "query", wrapQuery);
  return () => {
    unpatchMethod(target, "query");
  };
}
