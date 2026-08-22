/** Adapter for `mssql` (SQL Server). */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import type { StatementKind } from "../normalize.js";
import {
  combineRestores,
  disabled,
  observe,
  patchMethod,
  unpatchMethod,
  type AnyFn,
} from "./shared.js";

interface MssqlModule {
  Request?: { prototype: Record<string, any> };
}

interface RequestParameter {
  value?: unknown;
}

interface RequestLike {
  parameters?: Record<string, RequestParameter>;
}

function parameterValues(request: unknown): readonly unknown[] | undefined {
  const parameters = (request as RequestLike | undefined)?.parameters;
  if (parameters === undefined) return undefined;
  return Object.values(parameters).map((parameter) => parameter.value);
}

function isTemplateStrings(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && "raw" in value;
}

function wrapQuery(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const [statement, ...templateValues] = args;
    if (typeof statement === "string") {
      return observe(
        { sql: statement, params: parameterValues(this) },
        () => original.apply(this, args),
      );
    }
    if (isTemplateStrings(statement)) {
      return observe(
        { sql: statement.join("?"), params: templateValues },
        () => original.apply(this, args),
      );
    }
    return original.apply(this, args);
  };
}

function wrapExecute(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);
    const [procedure] = args;
    if (typeof procedure !== "string") return original.apply(this, args);
    const kind: StatementKind = "other";
    return observe(
      { sql: procedure, params: parameterValues(this), kind },
      () => original.apply(this, args),
    );
  };
}

/**
 * Instruments the `mssql` module.
 *
 * Request parameters accumulated with `.input()` are recorded when `query()`
 * or `execute()` runs. Tagged templates are captured with their interpolated
 * values, and stored procedure calls are recorded as `other` operations.
 */
export function instrumentMssql(mssql: MssqlModule): () => void {
  if (mssql.Request === undefined) {
    throw new TypeError(
      "instrumentMssql() expected the mssql module (with a Request export).",
    );
  }

  const target = mssql.Request.prototype;
  patchMethod(target, "query", wrapQuery);
  patchMethod(target, "execute", wrapExecute);
  return combineRestores([
    () => {
      unpatchMethod(target, "query");
    },
    () => {
      unpatchMethod(target, "execute");
    },
  ]);
}
