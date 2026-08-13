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
 *
 * ## Which building call
 *
 * Capturing only the *first* call in the chain names the wrong line whenever a
 * query is built somewhere other than where it runs:
 *
 * ```ts
 * function baseQuery() {
 *   return db.select().from(items);            // captured — but shared by every caller
 * }
 * for (const order of orders) {
 *   await baseQuery().where(eq(items.orderId, order.id));   // the N+1 lives here
 * }
 * ```
 *
 * Every chained call is therefore captured, and the last one before execution
 * wins — `.where()` above *is* called from the loop, synchronously, so the
 * frame is there for the taking. The construction site is kept alongside it and
 * reported when the two differ.
 *
 * It does not recover everything. If the whole chain lives inside the helper,
 * the last building call is still in the helper and there is no application
 * frame anywhere that says otherwise. Keeping both origins is what makes that
 * case honest rather than confidently wrong.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- ORM boundary */

import { runWithOrigin } from "../callsite-context.js";
import { captureBuildSite } from "./shared.js";
import type { CallSite } from "../callsite.js";

/**
 * How deep to walk when capturing a chained call.
 *
 * Shallow on purpose. A chained call made by application code puts that frame
 * at the top of the stack, so a handful is plenty, and this runs on every link
 * of every chain. When nothing application-owned turns up that shallow the
 * previous site is kept, so the failure mode is "no new information" rather
 * than a wrong line.
 */
const CHAIN_DEPTH = 8;

/**
 * The two origins of one query, refined as its chain is built.
 *
 * Mutable, and deliberately so: Drizzle's builders return `this`, so a builder
 * reused across loop iterations is the same object every time and the only way
 * to notice the loop is to update in place.
 */
interface Origin {
  readonly builtAt: CallSite | undefined;
  /** The application frame nearest execution seen so far. */
  latest: CallSite | undefined;
}

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
 * Wraps a query builder so that every chained call refines `origin`, and
 * executing the query publishes it.
 */
function wrapChain<T>(value: T, origin: Origin): T {
  if (!isPlainObject(value)) return value;

  return new Proxy(value as object, {
    get(target, property, receiver) {
      const inner = Reflect.get(target, property, receiver);
      if (typeof inner !== "function") return inner;

      // `.then()` / `.execute()` — the query is running; publish the origin so
      // the driver adapter underneath picks it up instead of the stack. Read
      // `latest` here rather than closing over it: a reused builder is refined
      // between construction and this moment.
      if (typeof property === "string" && EXECUTION_METHODS.has(property)) {
        return function execute(this: unknown, ...args: unknown[]): unknown {
          return runWithOrigin(
            { builtAt: origin.builtAt, executedAt: origin.latest },
            () => inner.apply(target, args),
          );
        };
      }

      // `.from()`, `.where()`, `.limit()` — still building, and still on the
      // caller's stack. Some return a new builder, some return `this`; both
      // have to carry the origin forward.
      return function chain(this: unknown, ...args: unknown[]): unknown {
        const site = captureBuildSite(CHAIN_DEPTH);
        const result = inner.apply(target, args);

        if (result === target) {
          // Same object, so the same origin: update it in place, which is what
          // makes a builder reused inside a loop point at the loop.
          if (site !== undefined) origin.latest = site;
          return receiver;
        }

        // A new builder. Give it an origin of its own so refining the child
        // never rewrites the parent's — two queries can branch off one base.
        return wrapChain(result, {
          builtAt: origin.builtAt,
          latest: site ?? origin.latest,
        });
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
          const callsite = captureBuildSite();

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
          return wrapChain(result, { builtAt: callsite, latest: callsite });
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
