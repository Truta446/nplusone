/**
 * Adapter for `@libsql/client`, including Turso remote and embedded clients.
 *
 * libSQL accepts either SQL strings or statement objects. A batch is one
 * network round trip but contains multiple database statements, so each entry
 * is recorded separately. Otherwise a batch loop could hide an N+1.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

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

type LibsqlArgs = readonly unknown[] | Record<string, unknown>;

interface LibsqlStatementObject {
  sql: string;
  args?: LibsqlArgs | undefined;
}

interface LibsqlClient {
  execute(...args: any[]): any;
  batch(...args: any[]): any;
  transaction?(...args: any[]): any;
  executeMultiple?(...args: any[]): any;
}

function paramsOf(args: LibsqlArgs | undefined): readonly unknown[] | undefined {
  if (args === undefined) return undefined;
  return Array.isArray(args) ? args : [args];
}

function observationOf(statement: unknown): Observation | undefined {
  if (typeof statement === "string") return { sql: statement };
  if (typeof statement !== "object" || statement === null) return undefined;

  const { sql, args } = statement as Partial<LibsqlStatementObject>;
  if (typeof sql !== "string") return undefined;

  return { sql, params: paramsOf(args) };
}

function wrapExecute(isActive: () => boolean): (original: AnyFn) => AnyFn {
  return function make(original: AnyFn): AnyFn {
    return function patchedExecute(this: unknown, ...args: unknown[]): unknown {
      if (!isActive() || disabled()) return original.apply(this, args);

      const observation = observationOf(args[0]);
      if (observation === undefined) return original.apply(this, args);

      return observe(observation, () => original.apply(this, args));
    };
  };
}

function wrapBatch(isActive: () => boolean): (original: AnyFn) => AnyFn {
  return function make(original: AnyFn): AnyFn {
    return function patchedBatch(this: unknown, ...args: unknown[]): unknown {
      if (!isActive() || disabled()) return original.apply(this, args);

      const statements = args[0];
      if (!Array.isArray(statements)) return original.apply(this, args);

      const observations = statements
        .map(observationOf)
        .filter((observation): observation is Observation => observation !== undefined);

      // One round trip, several statements — see observeBatch() for why they are
      // not each wrapped in their own observe().
      return observeBatch(observations, () => original.apply(this, args));
    };
  };
}

function thenableOf(value: unknown): Promise<unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const then = (value as { then?: unknown }).then;
  if (typeof then !== "function") return undefined;
  return value as Promise<unknown>;
}

/**
 * `executeMultiple` takes a semicolon-separated script. Recording it as N
 * statements by splitting on `;` is wrong the moment a semicolon appears
 * inside a string literal or a trigger body. A migration script is also not
 * the kind of thing an N+1 detector is for, so the whole script is one
 * statement — visible, but never exploded into a false N+1.
 */
function wrapExecuteMultiple(isActive: () => boolean): (original: AnyFn) => AnyFn {
  return function make(original: AnyFn): AnyFn {
    return function patchedExecuteMultiple(this: unknown, ...args: unknown[]): unknown {
      if (!isActive() || disabled()) return original.apply(this, args);

      const sql = args[0];
      if (typeof sql !== "string") return original.apply(this, args);

      return observe({ sql }, () => original.apply(this, args));
    };
  };
}

/**
 * Instruments one `@libsql/client` client.
 *
 * ```ts
 * import { createClient } from "@libsql/client";
 * import { instrumentLibsql } from "nplusone/libsql";
 *
 * const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
 * const restore = instrumentLibsql(client);
 * ```
 *
 * The returned function restores the client's original methods.
 */
export function instrumentLibsql(client: LibsqlClient): () => void {
  if (
    typeof client !== "object" ||
    client === null ||
    typeof client.execute !== "function" ||
    typeof client.batch !== "function"
  ) {
    throw new TypeError(
      "instrumentLibsql() expected a client with execute() and batch() methods.",
    );
  }

  const target = client as unknown as Record<string, any>;
  const restores: (() => void)[] = [];
  let active = true;
  const isActive = (): boolean => active;
  const executeWrap = wrapExecute(isActive);
  const batchWrap = wrapBatch(isActive);
  const executeMultipleWrap = wrapExecuteMultiple(isActive);

  function remember(object: Record<string, any>, name: string, wrap: (original: AnyFn) => AnyFn): void {
    if (!active) return;
    if (patchMethod(object, name, wrap)) {
      restores.push(() => {
        unpatchMethod(object, name);
      });
    }
  }

  function patchQueryMethods(object: Record<string, any>, retainRestore: boolean): void {
    if (retainRestore) {
      remember(object, "execute", executeWrap);
      remember(object, "batch", batchWrap);
      if (typeof object.executeMultiple === "function") {
        remember(object, "executeMultiple", executeMultipleWrap);
      }
      return;
    }

    // Transaction objects are short-lived. Patch them, but do not retain
    // restore closures that would pin every completed transaction until the
    // adapter itself is restored. The wrappers no-op once `active` is false.
    if (!active) return;
    patchMethod(object, "execute", executeWrap);
    patchMethod(object, "batch", batchWrap);
    if (typeof object.executeMultiple === "function") {
      patchMethod(object, "executeMultiple", executeMultipleWrap);
    }
  }

  function wrapTransaction(original: AnyFn): AnyFn {
    return function patchedTransaction(this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args);

      const attach = (transaction: unknown): unknown => {
        if (active && typeof transaction === "object" && transaction !== null) {
          patchQueryMethods(transaction as Record<string, any>, false);
        }
        return transaction;
      };

      const pending = thenableOf(result);
      return pending === undefined ? attach(result) : pending.then(attach);
    };
  }

  patchQueryMethods(target, true);
  if (typeof target.transaction === "function") {
    remember(target, "transaction", wrapTransaction);
  }

  return () => {
    active = false;
    combineRestores(restores)();
  };
}
