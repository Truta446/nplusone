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
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { shared } from "./global-state.js";
import type { CallSite } from "./callsite.js";

const storage = shared("callsite-storage", () => new AsyncLocalStorage<CallSite>());

/** Runs `fn` with `callsite` published to any adapter underneath it. */
export function runWithCallSite<T>(callsite: CallSite | undefined, fn: () => T): T {
  if (callsite === undefined) return fn();
  return storage.run(callsite, fn);
}

/** The call site published by an ORM adapter, if any. */
export function ambientCallSite(): CallSite | undefined {
  return storage.getStore();
}
