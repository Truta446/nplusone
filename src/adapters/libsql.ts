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

function wrapExecute(original: AnyFn): AnyFn {
  return function patchedExecute(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const observation = observationOf(args[0]);
    if (observation === undefined) return original.apply(this, args);

    return observe(observation, () => original.apply(this, args));
  };
}

function wrapBatch(original: AnyFn): AnyFn {
  return function patchedBatch(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const statements = args[0];
    if (!Array.isArray(statements)) return original.apply(this, args);

    const observations = statements
      .map(observationOf)
      .filter((observation): observation is Observation => observation !== undefined);

    // One round trip, several statements — see observeBatch() for why they are
    // not each wrapped in their own observe().
    return observeBatch(observations, () => original.apply(this, args));
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

  if (patchMethod(target, "execute", wrapExecute)) {
    restores.push(() => {
      unpatchMethod(target, "execute");
    });
  }

  if (patchMethod(target, "batch", wrapBatch)) {
    restores.push(() => {
      unpatchMethod(target, "batch");
    });
  }

  return combineRestores(restores);
}
