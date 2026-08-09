/**
 * Process-wide singletons.
 *
 * Bundlers duplicate modules. Next.js compiles each route handler into its own
 * bundle, so a route can end up with a *second* copy of this library: the copy
 * that patched the driver holds one AsyncLocalStorage, the copy that opened
 * the request scope holds another, and neither sees the other. Symptom, first
 * observed against a real Next.js admin app: the scope opens, the queries run,
 * and the detector reports zero.
 *
 * `Symbol.for` keys into the per-process global registry, so every copy of the
 * module resolves to the same object no matter how many times it was bundled.
 * Same fix covers Jest module isolation and monorepos that hoist two versions.
 */

const REGISTRY = Symbol.for("nplusone.global-state.v1");

type Registry = Record<string, unknown>;

function registry(): Registry {
  const host = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
  host[REGISTRY] ??= Object.create(null) as Registry;
  return host[REGISTRY];
}

/**
 * Returns the singleton stored under `key`, creating it on first use.
 *
 * `create` must be cheap and side-effect free — it may run in a copy of the
 * module that never uses the result.
 */
export function shared<T>(key: string, create: () => T): T {
  const store = registry();
  if (!(key in store)) store[key] = create();
  return store[key] as T;
}

/** Replaces a singleton. Used by configuration setters. */
export function setShared<T>(key: string, value: T): T {
  registry()[key] = value;
  return value;
}
