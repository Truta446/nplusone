/**
 * Machinery shared by every adapter.
 *
 * All of them do the same three things: replace a method, time the call, and
 * record it against the active scope with the call site captured *before* the
 * driver takes over — by the time a promise settles the application frame is
 * long gone from the stack.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import { captureCallSite, type CallSite } from "../callsite.js";
import { ambientOrigin } from "../callsite-context.js";
import { getOptions } from "../config.js";
import { record } from "../scope.js";
import type { StatementKind } from "../normalize.js";

export type AnyFn = (this: any, ...args: any[]) => any;

/** Marks a patched method and holds the original for restoration. */
const ORIGINAL = Symbol.for("nplusone.original");

interface Patched extends AnyFn {
  [ORIGINAL]?: AnyFn;
}

export function isPatched(fn: unknown): boolean {
  return typeof fn === "function" && ORIGINAL in (fn as Patched);
}

/**
 * Replaces `object[name]` with `make(original)`. Returns false when there is
 * nothing to patch or it is already patched, which is what keeps a second
 * `instrument*()` call from double counting every query.
 */
export function patchMethod(
  object: Record<string, any> | undefined,
  name: string,
  make: (original: AnyFn) => AnyFn,
): boolean {
  if (object === undefined || object === null) return false;
  const original = object[name] as AnyFn | undefined;
  if (typeof original !== "function") return false;
  if (isPatched(original)) return false;

  const patched = make(original) as Patched;
  Object.defineProperty(patched, ORIGINAL, { value: original, enumerable: false });
  Object.defineProperty(patched, "name", { value: name, configurable: true });
  object[name] = patched;
  return true;
}

export function unpatchMethod(
  object: Record<string, any> | undefined,
  name: string,
): boolean {
  if (object === undefined || object === null) return false;
  const current = object[name] as Patched | undefined;
  const original = typeof current === "function" ? current[ORIGINAL] : undefined;
  if (original === undefined) return false;
  object[name] = original;
  return true;
}

/** Composes several restore functions into one. */
export function combineRestores(restores: readonly (() => void)[]): () => void {
  return () => {
    // Reverse order, so nested patches unwind the way they were applied.
    for (let i = restores.length - 1; i >= 0; i--) restores[i]!();
  };
}

export interface Observation {
  sql: string;
  params?: readonly unknown[] | undefined;
  kind?: StatementKind | undefined;
}

/** What a driver adapter knows about where a query came from. */
export interface CapturedOrigin {
  /** The line to report and to group by. */
  callsite: CallSite | undefined;
  /**
   * Where the builder was constructed, when an ORM adapter distinguished it
   * from the line that executed the query. Undefined when there is nothing to
   * add beyond `callsite`.
   */
  builtAt: CallSite | undefined;
}

/**
 * Captures where the query came from, if attribution is enabled.
 *
 * An ORM adapter above us may already know the answer — see
 * {@link ambientOrigin}. Its value wins, because for a lazy ORM the stack at
 * this point contains nothing but driver and ORM internals.
 */
export function originNow(): CapturedOrigin {
  const options = getOptions();
  if (!options.captureStack) return { callsite: undefined, builtAt: undefined };

  const ambient = ambientOrigin();
  if (ambient !== undefined) {
    return {
      callsite: ambient.executedAt ?? ambient.builtAt,
      builtAt: ambient.builtAt,
    };
  }

  return {
    callsite: captureCallSite({
      ignore: options.ignoreCallSites,
      depth: options.stackDepth,
    }),
    builtAt: undefined,
  };
}

/** The single call site a driver adapter should report. */
export function captureNow(): CallSite | undefined {
  return originNow().callsite;
}

/**
 * Captures the caller's frame for an ORM adapter, ignoring any ambient origin.
 *
 * An ORM adapter is the thing that *publishes* an origin, so it must read the
 * real stack rather than whatever an enclosing query left behind — otherwise a
 * query built while another one executes inherits the wrong line.
 *
 * `depth` exists because a chained call is captured on every link: the frame
 * wanted is the immediate caller, and walking thirty frames on every `.where()`
 * would multiply the one cost this library is careful about.
 */
export function captureBuildSite(depth?: number): CallSite | undefined {
  const options = getOptions();
  if (!options.captureStack) return undefined;

  return captureCallSite({
    ignore: options.ignoreCallSites,
    depth: depth ?? options.stackDepth,
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Runs `execute` once and records several statements against it — one driver
 * round trip that carries a batch.
 *
 * Recording each statement with its own {@link observe} would mean nesting one
 * call inside the next, and every outer timer would then include all the inner
 * ones: a batch of six reads as roughly five times the time it actually took,
 * and one of fifty as twenty-five. A batch loop is exactly where an N+1 hides,
 * so that number needs to be trustworthy.
 *
 * Drivers report no per-statement timing for a batch, so the round trip is
 * divided evenly. Each statement's duration is an estimate; the **sum**, which
 * is what a finding reports, is the measurement.
 */
export function observeBatch<T>(
  observations: readonly Observation[],
  execute: () => T,
): T {
  if (observations.length === 0) return execute();

  const { callsite, builtAt } = originNow();
  const started = performance.now();

  const commit = (): void => {
    const each = (performance.now() - started) / observations.length;
    for (const observation of observations) {
      record({
        sql: observation.sql,
        params: observation.params,
        kind: observation.kind,
        callsite,
        builtAt,
        durationMs: each,
      });
    }
  };

  const commitQuietly = (): void => {
    try {
      commit();
    } catch {
      // Same reasoning as observe(): the driver's error wins.
    }
  };

  let result: T;
  try {
    result = execute();
  } catch (error) {
    commitQuietly();
    throw error;
  }

  if (isThenable(result)) {
    return (result as PromiseLike<unknown>).then(
      (value) => {
        commit();
        return value;
      },
      (error: unknown) => {
        commitQuietly();
        throw error;
      },
    ) as T;
  }

  commit();
  return result;
}

/**
 * Runs `execute`, recording the query when it completes. Handles synchronous
 * returns and promises alike, so one helper covers `better-sqlite3` and `pg`.
 *
 * On the failure path the recording is made quietly: a query that errored is
 * still worth counting, but a detector throwing there would mask the database
 * error that the caller actually needs to see.
 */
export function observe<T>(observation: Observation, execute: () => T): T {
  const { callsite, builtAt } = originNow();
  const started = performance.now();

  const commit = (): void => {
    record({
      sql: observation.sql,
      params: observation.params,
      kind: observation.kind,
      callsite,
      builtAt,
      durationMs: performance.now() - started,
    });
  };

  const commitQuietly = (): void => {
    try {
      commit();
    } catch {
      // Swallow NPlusOneError here — the original failure wins.
    }
  };

  let result: T;
  try {
    result = execute();
  } catch (error) {
    commitQuietly();
    throw error;
  }

  if (isThenable(result)) {
    return (result as PromiseLike<unknown>).then(
      (value) => {
        commit();
        return value;
      },
      (error: unknown) => {
        commitQuietly();
        throw error;
      },
    ) as T;
  }

  commit();
  return result;
}

/** True when the detector is switched off, so adapters can skip their work. */
export function disabled(): boolean {
  return !getOptions().enabled;
}
