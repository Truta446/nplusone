/**
 * Adapter for Prisma.
 *
 * Prisma is the one mainstream ORM that driver-level instrumentation misses:
 * by default it does not use `pg` or `mysql2` at all, it talks to the database
 * through its own query engine. So it needs its own hook.
 *
 * We use a client extension rather than the `$on("query")` event, and that
 * choice matters. The event fires asynchronously *after* the query completes,
 * outside the AsyncLocalStorage context that the request scope lives in — the
 * query would be attributed to no scope at all. An extension runs inline with
 * the call, so both the scope and the caller's stack frame are still there.
 *
 * The trade-off: what gets recorded is the Prisma operation (`User.findMany`),
 * not the SQL the engine generates. For finding N+1s that is arguably the more
 * useful view, since it names the call you would have to batch.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- ORM boundary */

import { observe } from "./shared.js";
import type { StatementKind } from "../normalize.js";

interface PrismaLike {
  $extends: (extension: any) => any;
}

const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "$queryRaw",
  "$queryRawUnsafe",
]);

const WRITE_KINDS: Record<string, StatementKind> = {
  create: "insert",
  createMany: "insert",
  createManyAndReturn: "insert",
  update: "update",
  updateMany: "update",
  upsert: "update",
  delete: "delete",
  deleteMany: "delete",
};

function kindOf(operation: string): StatementKind {
  if (READ_OPERATIONS.has(operation)) return "select";
  return WRITE_KINDS[operation] ?? "other";
}

/**
 * Recovers the SQL text from a raw query's arguments when Prisma exposes it,
 * so `$queryRaw` reports the statement rather than an opaque label.
 */
function rawSql(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;

  const candidate = args as { sql?: unknown; strings?: unknown; text?: unknown };
  if (typeof candidate.sql === "string") return candidate.sql;
  if (typeof candidate.text === "string") return candidate.text;

  // Prisma.Sql keeps the template literal chunks around.
  if (Array.isArray(candidate.strings)) {
    return candidate.strings.join("?");
  }

  return undefined;
}

/**
 * Returns an instrumented Prisma client.
 *
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * import { instrumentPrisma } from "nplusone/prisma";
 *
 * export const prisma = instrumentPrisma(new PrismaClient());
 * ```
 *
 * Unlike the driver adapters, this does not patch in place — Prisma clients are
 * immutable, so `$extends` hands back a new one. **Use the returned client**;
 * the original stays uninstrumented.
 */
export function instrumentPrisma<T extends PrismaLike>(client: T): T {
  if (client === null || typeof client.$extends !== "function") {
    throw new TypeError(
      "instrumentPrisma() expected a PrismaClient instance (with $extends). " +
        "Prisma 4.16+ is required.",
    );
  }

  return client.$extends({
    name: "nplusone",
    query: {
      // Covers every model operation and the raw query helpers.
      $allOperations({
        model,
        operation,
        args,
        query,
      }: {
        model?: string;
        operation: string;
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) {
        const label =
          model === undefined ? operation : `${model}.${operation}`;
        const sql = operation.startsWith("$query") || operation.startsWith("$execute")
          ? (rawSql(args) ?? label)
          : label;

        return observe(
          { sql, params: [args], kind: kindOf(operation) },
          () => query(args),
        );
      },
    },
  }) as T;
}
