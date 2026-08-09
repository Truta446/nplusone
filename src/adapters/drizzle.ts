/**
 * Adapter for Drizzle ORM.
 *
 * Drizzle already runs through an instrumented driver, so its queries are
 * *detected* without this adapter. What is missing is attribution.
 *
 * A Drizzle query is a lazy thenable: `await db.select().from(t)` is executed
 * by the runtime calling `.then()`, and at that moment the stack holds nothing
 * but Drizzle and driver internals — the line that built the query is gone.
 * Measured against Drizzle 0.45: twelve frames, zero belonging to the caller.
 *
 * So this adapter captures the call site during the *synchronous* building
 * phase, where the caller is still on the stack, and republishes it while the
 * query executes. The driver adapter prefers that over its own stack walk. Net
 * result: the SQL still comes from the driver, and the line comes from here.
 *
 * It works for every dialect, since it never touches the driver itself.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- ORM boundary */

import { runWithCallSite } from "../callsite-context.js";
import { captureNow } from "./shared.js";
import type { CallSite } from "../callsite.js";

/**
 * Methods whose invocation means "the query is being executed now".
 *
 * Deliberately excludes `values`: in Drizzle that builds an insert
 * (`db.insert(t).values({...})`) rather than executing anything, and treating
 * it as execution breaks the chain so inserts lose their attribution.
 */
const EXECUTION_METHODS = new Set(["then", "execute", "catch", "finally"]);

/** Namespaces on the db object worth walking into, e.g. `db.query.users`. */
const NAMESPACES = new Set(["query", "_query"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Promise) return false;
  if (value instanceof Date) return false;
  return true;
}

/**
 * Wraps a query builder so that every chained call keeps carrying `callsite`,
 * and executing the query publishes it.
 */
function wrapChain<T>(value: T, callsite: CallSite | undefined): T {
  if (!isPlainObject(value)) return value;

  return new Proxy(value as object, {
    get(target, property, receiver) {
      const inner = Reflect.get(target, property, receiver);
      if (typeof inner !== "function") return inner;

      // `.then()` / `.execute()` — the query is running; publish the call site
      // so the driver adapter underneath picks it up instead of the stack.
      if (typeof property === "string" && EXECUTION_METHODS.has(property)) {
        return function execute(this: unknown, ...args: unknown[]): unknown {
          return runWithCallSite(callsite, () => inner.apply(target, args));
        };
      }

      // `.from()`, `.where()`, `.limit()` — still building. Some return a new
      // builder, some return `this`; both have to keep the call site.
      return function chain(this: unknown, ...args: unknown[]): unknown {
        const result = inner.apply(target, args);
        if (result === target) return receiver;
        return wrapChain(result, callsite);
      };
    },
  }) as T;
}

/**
 * Wraps the database object (and namespaces like `db.query`) so that calling
 * any method captures the caller's frame — this is the one moment the caller
 * is still on the stack.
 */
function wrapNamespace<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const inner = Reflect.get(object, property, receiver);

      if (typeof inner === "function") {
        return function start(this: unknown, ...args: unknown[]): unknown {
          const callsite = captureNow();

          // `db.transaction(cb)` hands a scoped db to the callback; that one
          // needs instrumenting too, or every query inside a transaction goes
          // back to being unattributed.
          const forwarded = args.map((argument) =>
            typeof argument === "function"
              ? function instrumentedCallback(this: unknown, ...inner_: unknown[]): unknown {
                  const [tx, ...rest] = inner_;
                  const wrapped = isPlainObject(tx) ? wrapNamespace(tx) : tx;
                  return (argument as (...a: unknown[]) => unknown).apply(this, [
                    wrapped,
                    ...rest,
                  ]);
                }
              : argument,
          );

          const result = inner.apply(object, forwarded);
          if (result === object) return receiver;
          return wrapChain(result, callsite);
        };
      }

      // Walk into `db.query`, and into each table under it.
      if (typeof property === "string" && isPlainObject(inner)) {
        if (NAMESPACES.has(property)) return wrapNamespace(inner);
      }

      return inner;
    },
  });
}

/**
 * Returns an instrumented Drizzle database.
 *
 * ```ts
 * import { drizzle } from "drizzle-orm/postgres-js";
 * import { instrumentDrizzle } from "nplusone/drizzle";
 *
 * export const db = instrumentDrizzle(drizzle(sql, { schema }));
 * ```
 *
 * Use it **together with** the driver adapter, not instead of it: the driver
 * reports the SQL, this reports the line. Like the Prisma adapter it returns a
 * new object rather than patching in place, so use the returned value.
 */
export function instrumentDrizzle<T extends object>(db: T): T {
  if (db === null || typeof db !== "object") {
    throw new TypeError(
      "instrumentDrizzle() expected the database returned by drizzle().",
    );
  }
  return wrapNamespace(db);
}
