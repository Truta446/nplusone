/**
 * Ambient call site propagation.
 *
 * Driver-level instrumentation reads the stack at the moment a query is sent,
 * which works when the application calls the driver itself. It breaks for lazy
 * ORMs: with Drizzle, `await db.select()...` is executed by the runtime calling
 * `.then()`, and by then every frame belonging to the application has left the
 * stack — only `node_modules` remains.
 *
 * The fix is to capture the call site where it still exists (the synchronous
 * query-building call) and publish it here for the duration of the execution.
 * The driver adapter then prefers this over its own stack walk, so the SQL
 * comes from the driver and the attribution comes from the ORM.
 *
 * There are **two** places worth remembering, not one. Construction and
 * execution are often the same line, but when they are not — a repository
 * helper builds the query and a route loops over it — the line that matters is
 * the loop, and the line the ORM can capture first is the helper. So an origin
 * carries both, and the reporter shows the useful one.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { shared } from "./global-state.js";
import type { CallSite } from "./callsite.js";

/** Where a query came from, as far as an ORM adapter can tell. */
export interface QueryOrigin {
  /** Where the query builder was first constructed. */
  builtAt: CallSite | undefined;
  /**
   * The application frame nearest to execution — in practice the last chained
   * call before the query ran, which is the loop when there is one.
   */
  executedAt: CallSite | undefined;
}

const storage = shared("callsite-storage", () => new AsyncLocalStorage<QueryOrigin>());

/** Runs `fn` with `origin` published to any adapter underneath it. */
export function runWithOrigin<T>(origin: QueryOrigin | undefined, fn: () => T): T {
  if (origin === undefined) return fn();
  if (origin.builtAt === undefined && origin.executedAt === undefined) return fn();
  return storage.run(origin, fn);
}

/**
 * Publishes a single call site, for an adapter that knows the semantic origin
 * and has nothing to distinguish. Construction and execution are taken to be
 * the same place, so the report stays as it was.
 */
export function runWithCallSite<T>(callsite: CallSite | undefined, fn: () => T): T {
  if (callsite === undefined) return fn();
  return storage.run({ builtAt: callsite, executedAt: undefined }, fn);
}

/** The origin published by an ORM adapter, if any. */
export function ambientOrigin(): QueryOrigin | undefined {
  return storage.getStore();
}

/**
 * The single call site to report: the frame nearest execution when the adapter
 * distinguished them, otherwise wherever the query was built.
 */
export function ambientCallSite(): CallSite | undefined {
  const origin = storage.getStore();
  if (origin === undefined) return undefined;
  return origin.executedAt ?? origin.builtAt;
}
