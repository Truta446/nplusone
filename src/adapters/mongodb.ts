/**
 * Adapter for `mongodb`.
 *
 * N+1 is not a SQL-only disease — looping over documents and fetching a
 * related one per iteration is just as common with Mongo, and there is no
 * query log staring you in the face to catch it.
 *
 * We patch `Collection.prototype`, which every driver call funnels through.
 * The recorded "statement" is `users.findOne` rather than SQL: that is the
 * call you would have to batch (into `$in` or an aggregation), so it is the
 * label that points at the fix.
 *
 * Command monitoring (`monitorCommands` plus `commandStarted`) would give the
 * real wire command, but those events fire asynchronously after the fact —
 * outside the AsyncLocalStorage context the request scope lives in — so the
 * query would belong to no scope at all.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import { record } from "../scope.js";
import {
  captureNow,
  combineRestores,
  disabled,
  observe,
  patchMethod,
  unpatchMethod,
  type AnyFn,
} from "./shared.js";
import type { StatementKind } from "../normalize.js";

/** Operations that return a promise and are worth counting. */
const AWAITED_METHODS: Record<string, StatementKind> = {
  findOne: "select",
  countDocuments: "select",
  estimatedDocumentCount: "select",
  distinct: "select",
  insertOne: "insert",
  insertMany: "insert",
  updateOne: "update",
  updateMany: "update",
  replaceOne: "update",
  findOneAndUpdate: "update",
  findOneAndReplace: "update",
  findOneAndDelete: "delete",
  deleteOne: "delete",
  deleteMany: "delete",
  bulkWrite: "other",
};

/**
 * Operations that return a lazy cursor. Recorded when the cursor is created,
 * which is where the call site is, rather than when it is drained.
 */
const CURSOR_METHODS: Record<string, StatementKind> = {
  find: "select",
  aggregate: "select",
  listIndexes: "other",
};

interface MongoModule {
  Collection?: { prototype: Record<string, any> };
}

function collectionNameOf(target: unknown): string {
  if (typeof target !== "object" || target === null) return "collection";
  const name = (target as { collectionName?: unknown }).collectionName;
  return typeof name === "string" ? name : "collection";
}

function wrapAwaited(operation: string, kind: StatementKind) {
  return (original: AnyFn): AnyFn =>
    function patched(this: unknown, ...args: unknown[]): unknown {
      if (disabled()) return original.apply(this, args);

      return observe(
        {
          sql: `${collectionNameOf(this)}.${operation}`,
          // The filter is what varies between iterations of an N+1 loop, so it
          // is the discriminator.
          params: args.length > 0 ? args : undefined,
          kind,
        },
        () => original.apply(this, args),
      );
    };
}

function wrapCursor(operation: string, kind: StatementKind) {
  return (original: AnyFn): AnyFn =>
    function patched(this: unknown, ...args: unknown[]): unknown {
      if (disabled()) return original.apply(this, args);

      const callsite = captureNow();
      const cursor = original.apply(this, args);

      // A cursor executes lazily, so there is no duration to report here — but
      // creating one per loop iteration is the pattern we are looking for.
      // In throw mode this raises, which is the intended failure.
      record({
        sql: `${collectionNameOf(this)}.${operation}`,
        params: args.length > 0 ? args : undefined,
        kind,
        callsite,
      });

      return cursor;
    };
}

/**
 * Instruments the `mongodb` module.
 *
 * ```ts
 * import * as mongodb from "mongodb";
 * import { instrumentMongodb } from "nplusone/mongodb";
 *
 * instrumentMongodb(mongodb);
 * ```
 *
 * Call it once, before opening a client.
 */
export function instrumentMongodb(mongoModule: MongoModule): () => void {
  if (mongoModule?.Collection === undefined) {
    throw new TypeError(
      "instrumentMongodb() expected the mongodb module (with a Collection export).",
    );
  }

  const prototype = mongoModule.Collection.prototype;
  const restores: (() => void)[] = [];

  for (const [operation, kind] of Object.entries(AWAITED_METHODS)) {
    if (patchMethod(prototype, operation, wrapAwaited(operation, kind))) {
      restores.push(() => {
        unpatchMethod(prototype, operation);
      });
    }
  }

  for (const [operation, kind] of Object.entries(CURSOR_METHODS)) {
    if (patchMethod(prototype, operation, wrapCursor(operation, kind))) {
      restores.push(() => {
        unpatchMethod(prototype, operation);
      });
    }
  }

  return combineRestores(restores);
}

/**
 * Instruments a single collection rather than the whole driver. Handy when you
 * only care about one hot collection.
 */
export function instrumentMongoCollection(collection: object): () => void {
  const target = collection as Record<string, any>;
  const restores: (() => void)[] = [];

  for (const [operation, kind] of Object.entries(AWAITED_METHODS)) {
    if (patchMethod(target, operation, wrapAwaited(operation, kind))) {
      restores.push(() => {
        unpatchMethod(target, operation);
      });
    }
  }
  for (const [operation, kind] of Object.entries(CURSOR_METHODS)) {
    if (patchMethod(target, operation, wrapCursor(operation, kind))) {
      restores.push(() => {
        unpatchMethod(target, operation);
      });
    }
  }

  return combineRestores(restores);
}
