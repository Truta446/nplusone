/**
 * Adapter for `mssql` (SQL Server).
 *
 * Everything the driver executes goes through `Request.prototype` — the
 * tagged-template helpers on `ConnectionPool` and the module-level `sql.query`
 * both build a `Request` and call it — so patching that one prototype covers
 * the pool, a transaction's request, and a hand-built one alike.
 */

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
  PreparedStatement?: { prototype: Record<string, any> };
}

interface RequestParameter {
  value?: unknown;
}

interface RequestLike {
  parameters?: Record<string, RequestParameter>;
}

/**
 * The values bound with `.input()`, or undefined when nothing was bound.
 *
 * The distinction matters more than it looks. A scope tells an N+1 from a
 * statement that merely runs twice by watching the *values* vary, and falls
 * back to the raw SQL when the driver reports none. Returning `[]` for a request
 * with no inputs would hand it a discriminator that is identical on every
 * iteration, and a loop building its SQL by interpolation — the very code most
 * likely to have an N+1 in it — would never be reported.
 */
function parameterValues(request: unknown): readonly unknown[] | undefined {
  const parameters = (request as RequestLike | undefined)?.parameters;
  if (parameters === undefined) return undefined;
  const values = Object.values(parameters).map((parameter) => parameter.value);
  return values.length === 0 ? undefined : values;
}

function isTemplateStrings(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && "raw" in value;
}

/** `query()` and `batch()` take the same two forms: a string, or a template. */
function wrapStatement(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const [statement, ...templateValues] = args;
    if (typeof statement === "string") {
      return observe({ sql: statement, params: parameterValues(this) }, () =>
        original.apply(this, args),
      );
    }
    if (isTemplateStrings(statement)) {
      return observe({ sql: statement.join("?"), params: templateValues }, () =>
        original.apply(this, args),
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
    // A stored procedure is opaque: the work it does is not in its name, and
    // no amount of parsing will say whether it reads or writes.
    const kind: StatementKind = "other";
    return observe({ sql: procedure, params: parameterValues(this), kind }, () =>
      original.apply(this, args),
    );
  };
}

/**
 * The statement a prepared statement was prepared with.
 *
 * Captured at `prepare()` rather than read off the instance, because the
 * property `mssql` keeps it in is internal and would be a silent break the
 * first time it is renamed.
 */
const PREPARED_SQL = Symbol.for("nplusone.mssql.preparedSql");

function wrapPrepare(original: AnyFn): AnyFn {
  return function patched(this: any, ...args: unknown[]): unknown {
    const [statement] = args;
    if (typeof statement === "string") this[PREPARED_SQL] = statement;
    return original.apply(this, args);
  };
}

/**
 * A prepared statement executed in a loop is an N+1 that costs less per
 * iteration and is therefore easier to miss — the round trip is still there.
 */
function wrapPreparedExecute(original: AnyFn): AnyFn {
  return function patched(this: any, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const sql = this?.[PREPARED_SQL] as unknown;
    if (typeof sql !== "string") return original.apply(this, args);

    // `execute(values)` takes an object keyed by parameter name.
    const [values] = args;
    const params =
      typeof values === "object" && values !== null
        ? Object.values(values as Record<string, unknown>)
        : undefined;

    return observe({ sql, params }, () => original.apply(this, args));
  };
}

/**
 * Instruments the `mssql` module.
 *
 * ```ts
 * import mssql from "mssql";
 * import { instrumentMssql } from "nplusone/mssql";
 *
 * instrumentMssql(mssql);
 * ```
 *
 * Request parameters accumulated with `.input()` are recorded when `query()`,
 * `batch()` or `execute()` runs. Tagged templates are captured with their
 * interpolated values, stored procedure calls are recorded as `other`
 * operations, and a `PreparedStatement` is recorded with the statement it was
 * prepared with.
 */
export function instrumentMssql(mssql: MssqlModule): () => void {
  if (mssql.Request === undefined) {
    throw new TypeError(
      "instrumentMssql() expected the mssql module (with a Request export).",
    );
  }

  const request = mssql.Request.prototype;
  patchMethod(request, "query", wrapStatement);
  patchMethod(request, "batch", wrapStatement);
  patchMethod(request, "execute", wrapExecute);

  const restores: (() => void)[] = [
    () => {
      unpatchMethod(request, "query");
    },
    () => {
      unpatchMethod(request, "batch");
    },
    () => {
      unpatchMethod(request, "execute");
    },
  ];

  // Optional: older versions of the driver, and the fakes a test builds, need
  // not carry one.
  const prepared = mssql.PreparedStatement?.prototype;
  if (prepared !== undefined) {
    patchMethod(prepared, "prepare", wrapPrepare);
    patchMethod(prepared, "execute", wrapPreparedExecute);
    restores.push(
      () => {
        unpatchMethod(prepared, "prepare");
      },
      () => {
        unpatchMethod(prepared, "execute");
      },
    );
  }

  return combineRestores(restores);
}
