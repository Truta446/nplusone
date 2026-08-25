/**
 * Adapter for `oracledb` (Oracle Database).
 *
 * `node-oracledb` does not export its `Connection` class, so there is nothing
 * to patch at import time. What it does export is the two functions that hand
 * out connections — `getConnection()` and `createPool()` — so those are wrapped
 * instead, and the first connection to come back is used to reach the prototype
 * that every connection shares. From then on the prototype is patched and every
 * connection, pooled or not, is covered.
 *
 * That indirection is also what keeps a pooled query from being counted twice:
 * only the connection records, and the pool wrappers do nothing but adopt.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import type { StatementKind } from "../normalize.js";
import { statementKind } from "../normalize.js";
import {
  combineRestores,
  disabled,
  observe,
  observeBatch,
  patchMethod,
  unpatchMethod,
  type AnyFn,
  type Observation,
} from "./shared.js";

interface OracleModule {
  getConnection?: AnyFn;
  createPool?: AnyFn;
}

/**
 * Bind values as a flat array, or undefined when the statement has none.
 *
 * `execute()` takes binds either positionally (`[1]`) or by name (`{id: 1}`),
 * and both have to arrive here as values — the detector tells an N+1 from a
 * statement that merely ran twice by watching those values vary.
 *
 * A statement with **no** binds must report `undefined` rather than `[]`. An
 * empty array is a discriminator that is identical on every iteration, so a
 * loop that concatenates its ids into the SQL — the code most likely to have an
 * N+1 in it — would never be reported. That was a real bug in the `mssql`
 * adapter; see 0.8.0.
 */
function bindValues(binds: unknown): readonly unknown[] | undefined {
  if (Array.isArray(binds)) return binds.length === 0 ? undefined : binds;
  if (typeof binds === "object" && binds !== null) {
    const values = Object.values(binds as Record<string, unknown>);
    return values.length === 0 ? undefined : values;
  }
  return undefined;
}

/**
 * The statement kind, with Oracle's one trap handled.
 *
 * An anonymous PL/SQL block starts with `BEGIN` or `DECLARE`, which the shared
 * classifier reads as transaction control — and transaction control is dropped
 * before it ever reaches a scope. A PL/SQL block that runs once per row is an
 * N+1 like any other, so it would have gone missing entirely and silently.
 *
 * Oracle has no bare `BEGIN` statement to confuse this with: a transaction
 * there is implicit, and `COMMIT` / `ROLLBACK` still classify as control.
 */
function kindOf(sql: string): StatementKind {
  const kind = statementKind(sql);
  if (kind !== "control") return kind;
  return /^\s*(begin|declare)\b/i.test(sql) ? "other" : kind;
}

function wrapExecute(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const [sql, binds] = args;
    if (typeof sql !== "string") return original.apply(this, args);

    return observe({ sql, params: bindValues(binds), kind: kindOf(sql) }, () =>
      original.apply(this, args),
    );
  };
}

/**
 * `executeMany()` is one round trip carrying many statements.
 *
 * Recording each with its own {@link observe} would nest the timers, and a
 * batch of fifty would read as roughly twenty-five times the time it actually
 * took. A batch loop is exactly where an N+1 hides, so that number has to be
 * trustworthy — hence {@link observeBatch}, which divides the one round trip
 * evenly and reports the sum as the measurement.
 */
function wrapExecuteMany(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const [sql, bindsOrCount] = args;
    if (typeof sql !== "string") return original.apply(this, args);

    const kind = kindOf(sql);
    if (!Array.isArray(bindsOrCount)) {
      // The `numIterations` form: the driver was given a count, not rows, so
      // there are no per-iteration values to report.
      return observe({ sql, params: undefined, kind }, () =>
        original.apply(this, args),
      );
    }

    const observations: Observation[] = bindsOrCount.map((row) => ({
      sql,
      params: bindValues(row),
      kind,
    }));
    return observeBatch(observations, () => original.apply(this, args));
  };
}

/**
 * `queryStream()` hands back a stream that produces rows later.
 *
 * Recorded when the stream is created, which is where the call site is. There
 * is no duration to report — the rows arrive long afterwards — but opening one
 * stream per loop iteration is the pattern being looked for.
 */
function wrapQueryStream(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const [sql, binds] = args;
    if (typeof sql !== "string") return original.apply(this, args);

    return observe({ sql, params: bindValues(binds), kind: kindOf(sql) }, () =>
      original.apply(this, args),
    );
  };
}

const CONNECTION_METHODS: Record<string, (original: AnyFn) => AnyFn> = {
  execute: wrapExecute,
  executeMany: wrapExecuteMany,
  queryStream: wrapQueryStream,
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Patches the prototype a connection came from. Idempotent, per prototype. */
function adoptConnection(connection: unknown, restores: (() => void)[]): void {
  if (typeof connection !== "object" || connection === null) return;
  const prototype = Object.getPrototypeOf(connection) as Record<string, any> | null;
  if (prototype === null) return;

  for (const [name, make] of Object.entries(CONNECTION_METHODS)) {
    if (patchMethod(prototype, name, make)) {
      restores.push(() => {
        unpatchMethod(prototype, name);
      });
    }
  }
}

/** Patches `getConnection` on a pool, the same way and for the same reason. */
function adoptPool(pool: unknown, restores: (() => void)[]): void {
  if (typeof pool !== "object" || pool === null) return;
  const prototype = Object.getPrototypeOf(pool) as Record<string, any> | null;
  if (prototype === null) return;

  if (patchMethod(prototype, "getConnection", (original) => handOut(original, restores))) {
    restores.push(() => {
      unpatchMethod(prototype, "getConnection");
    });
  }
}

/**
 * Wraps something that hands back a connection (or a pool), so whatever it
 * resolves to gets adopted.
 *
 * Both shapes the driver offers are covered: a promise, and the callback form
 * where the connection arrives as the second argument.
 */
function handOut(
  original: AnyFn,
  restores: (() => void)[],
  adopt: (value: unknown, restores: (() => void)[]) => void = adoptConnection,
): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      const callback = last as AnyFn;
      const forwarded = args.slice(0, -1);
      forwarded.push(function (this: unknown, error: unknown, value: unknown) {
        if (error === null || error === undefined) adopt(value, restores);
        return callback.apply(this, [error, value]);
      });
      return original.apply(this, forwarded);
    }

    const result = original.apply(this, args);
    if (isThenable(result)) {
      return result.then((value: unknown) => {
        adopt(value, restores);
        return value;
      });
    }
    adopt(result, restores);
    return result;
  };
}

/**
 * Instruments the `oracledb` module.
 *
 * ```ts
 * import oracledb from "oracledb";
 * import { instrumentOracle } from "nplusone/oracledb";
 *
 * instrumentOracle(oracledb);
 * ```
 *
 * Call it once, before opening a connection or a pool. `execute`,
 * `executeMany` and `queryStream` are recorded; `executeMany` as a batch rather
 * than as N separate round trips.
 */
export function instrumentOracle(oracledb: OracleModule): () => void {
  if (typeof oracledb?.getConnection !== "function") {
    throw new TypeError(
      "instrumentOracle() expected the oracledb module (with a getConnection export). " +
        "Pass an open connection to instrumentOracleConnection() instead.",
    );
  }

  const target = oracledb as unknown as Record<string, any>;
  const restores: (() => void)[] = [];

  if (patchMethod(target, "getConnection", (original) => handOut(original, restores))) {
    restores.push(() => {
      unpatchMethod(target, "getConnection");
    });
  }

  if (
    typeof oracledb.createPool === "function" &&
    patchMethod(target, "createPool", (original) => handOut(original, restores, adoptPool))
  ) {
    restores.push(() => {
      unpatchMethod(target, "createPool");
    });
  }

  return combineRestores(restores);
}

/**
 * Instruments a connection you already have, rather than the module.
 *
 * This patches the prototype the connection came from, so it covers every
 * connection of that class — which is what you want, and worth knowing before
 * you reach for it expecting one connection to be isolated.
 */
export function instrumentOracleConnection(connection: object): () => void {
  const restores: (() => void)[] = [];
  adoptConnection(connection, restores);
  return combineRestores(restores);
}
