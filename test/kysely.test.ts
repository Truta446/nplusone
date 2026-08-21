/**
 * Kysely — a measurement, kept honest by a test.
 *
 * Issue #2 assumed Kysely would need an adapter for the same reason Drizzle
 * does: a lazy builder whose execution is triggered by the runtime, leaving no
 * application frame on the stack. Measured against Kysely 0.29 on both a
 * synchronous driver (`node:sqlite`) and an asynchronous one (`pg`), that turns
 * out to be false, and the reported line is correct in every shape tried —
 * including the helper-built loop that Drizzle gets wrong.
 *
 * The reason is structural rather than lucky. A Kysely builder is **not** a
 * thenable: nothing runs until you call `.execute()` yourself, and V8's async
 * stack traces keep the frame that awaited it. Drizzle's `.then()` is called by
 * the runtime from a microtask, so there is no such frame to keep.
 *
 * So there is no `nplusone/kysely`, and these tests exist to make sure that
 * stays true. If a future Kysely defers execution differently, this file fails
 * and the README claim stops being a claim nobody checks.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Kysely, sql } from "kysely";
import { configure, resetConfig, runInScope, type Scope } from "../src/index.js";
import { instrumentNodeSqlite } from "../src/adapters/sqlite.js";
import { DIALECT_FRAMES, nodeSqliteDialect } from "./helpers/kysely-dialect.js";

interface Schema {
  items: { id: number; order_id: number };
}

function seeded(): { db: Kysely<Schema>; restore: () => void } {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, order_id INTEGER)");
  for (let id = 1; id <= 6; id++) {
    database.prepare("INSERT INTO items (id, order_id) VALUES (?, ?)").run(id, id);
  }
  const restore = instrumentNodeSqlite({ DatabaseSync });
  return { db: new Kysely<Schema>({ dialect: nodeSqliteDialect(database) }), restore };
}

/** The function named by the finding, which is what the reader acts on. */
function blamed(scope: Scope): string {
  const finding = scope.findings.find((f) => f.type === "n_plus_one");
  return finding?.callsite?.function ?? "<none>";
}

beforeEach(() => {
  resetConfig();
  configure({
    mode: "silent",
    enabled: true,
    threshold: 3,
    duplicateThreshold: 99,
    // The stand-in dialect stands in for library code — see the helper.
    ignoreCallSites: [DIALECT_FRAMES],
  });
});

test("attributes a Kysely N+1 to the loop, with no adapter", async () => {
  const { db, restore } = seeded();

  async function theLoop(): Promise<void> {
    for (let id = 1; id <= 5; id++) {
      await db.selectFrom("items").selectAll().where("order_id", "=", id).execute();
    }
  }

  await runInScope("inline", async (scope) => {
    await theLoop();
    assert.equal(scope.queryCount, 5);
    assert.match(blamed(scope), /theLoop/);
  });
  restore();
});

test("attributes a helper-built Kysely query to the loop, not the helper", async () => {
  const { db, restore } = seeded();

  // The shape Drizzle gets wrong (#12) and needs an adapter for. Kysely gets it
  // right unaided, because `.execute()` is called from the loop and awaited
  // there, so the loop's frame survives in the async stack.
  function baseQuery() {
    return db.selectFrom("items").selectAll();
  }
  async function helperLoop(): Promise<void> {
    for (let id = 1; id <= 5; id++) {
      await baseQuery().where("order_id", "=", id).execute();
    }
  }

  await runInScope("helper", async (scope) => {
    await helperLoop();
    assert.match(blamed(scope), /helperLoop/);
  });
  restore();
});

test("attributes executeTakeFirst the same way", async () => {
  const { db, restore } = seeded();

  async function takeFirstLoop(): Promise<void> {
    for (let id = 1; id <= 5; id++) {
      await db.selectFrom("items").selectAll().where("id", "=", id).executeTakeFirst();
    }
  }

  await runInScope("takeFirst", async (scope) => {
    await takeFirstLoop();
    assert.match(blamed(scope), /takeFirstLoop/);
  });
  restore();
});

test("attributes a raw sql`` template", async () => {
  const { db, restore } = seeded();

  async function rawLoop(): Promise<void> {
    for (let id = 1; id <= 5; id++) {
      await sql`SELECT * FROM items WHERE order_id = ${id}`.execute(db);
    }
  }

  await runInScope("raw", async (scope) => {
    await rawLoop();
    assert.match(blamed(scope), /rawLoop/);
  });
  restore();
});

test("does not report a batched Kysely query as an N+1", async () => {
  const { db, restore } = seeded();

  await runInScope("batched", async (scope) => {
    const rows = await db
      .selectFrom("items")
      .selectAll()
      .where("order_id", "in", [1, 2, 3, 4, 5])
      .execute();

    assert.equal(rows.length, 5, "the query really ran and really returned rows");
    assert.equal(scope.queryCount, 1);
    assert.equal(scope.findings.length, 0);
  });
  restore();
});
