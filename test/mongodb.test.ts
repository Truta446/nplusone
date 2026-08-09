import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import {
  instrumentMongodb,
  instrumentMongoCollection,
} from "../src/adapters/mongodb.js";

/** Stands in for mongodb's Collection: promise methods plus lazy cursors. */
class FakeCollection {
  calls = 0;

  constructor(readonly collectionName: string) {}

  async findOne(_filter?: unknown): Promise<unknown> {
    this.calls++;
    return { _id: 1 };
  }

  async insertOne(_doc?: unknown): Promise<unknown> {
    this.calls++;
    return { insertedId: 1 };
  }

  async updateOne(_filter?: unknown, _update?: unknown): Promise<unknown> {
    this.calls++;
    return { modifiedCount: 1 };
  }

  find(_filter?: unknown): { toArray: () => Promise<unknown[]> } {
    this.calls++;
    return { toArray: async () => [{ _id: 1 }] };
  }

  aggregate(_pipeline?: unknown): { toArray: () => Promise<unknown[]> } {
    this.calls++;
    return { toArray: async () => [] };
  }
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("detects an N+1 of findOne calls", async () => {
  const restore = instrumentMongodb({ Collection: FakeCollection });
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (f) => findings.push(f) });

  const users = new FakeCollection("users");
  await runInScope("GET /feed", async () => {
    for (let i = 0; i < 8; i++) {
      await users.findOne({ _id: i });
    }
  });

  restore();
  assert.equal(users.calls, 8, "the driver calls still happened");
  const nPlusOnes = findings.filter((f) => f.type === "n_plus_one");
  assert.equal(nPlusOnes.length, 1);
  assert.equal(nPlusOnes[0]!.count, 8);
  assert.equal(
    nPlusOnes[0]!.normalized,
    "users.findOne",
    "the label names the collection and the operation you would batch",
  );
});

test("records lazily created cursors", async () => {
  const restore = instrumentMongodb({ Collection: FakeCollection });
  const findings: Finding[] = [];
  configure({ threshold: 4, onFinding: (f) => findings.push(f) });

  const posts = new FakeCollection("posts");
  await runInScope("cursors", async () => {
    for (let i = 0; i < 5; i++) {
      await posts.find({ authorId: i }).toArray();
    }
  });

  restore();
  assert.equal(findings.filter((f) => f.type === "n_plus_one").length, 1);
  assert.equal(findings[0]!.normalized, "posts.find");
});

test("classifies reads and writes so the statements filter works", async () => {
  const restore = instrumentMongodb({ Collection: FakeCollection });
  const findings: Finding[] = [];
  configure({ threshold: 3, statements: ["select"], onFinding: (f) => findings.push(f) });

  const users = new FakeCollection("users");
  await runInScope("mixed", async () => {
    for (let i = 0; i < 5; i++) await users.insertOne({ _id: i });
    for (let i = 0; i < 5; i++) await users.findOne({ _id: i });
  });

  restore();
  assert.equal(findings.length, 1, "only the reads should be considered");
  assert.equal(findings[0]!.normalized, "users.findOne");
  assert.equal(findings[0]!.kind, "select");
});

test("keeps collections apart", async () => {
  const restore = instrumentMongodb({ Collection: FakeCollection });
  const findings: Finding[] = [];
  configure({ threshold: 4, onFinding: (f) => findings.push(f) });

  const users = new FakeCollection("users");
  const posts = new FakeCollection("posts");
  await runInScope("two-collections", async () => {
    for (let i = 0; i < 3; i++) {
      await users.findOne({ _id: i });
      await posts.findOne({ _id: i });
    }
  });

  restore();
  // Three each, from different collections — neither reaches four.
  assert.deepEqual(findings, []);
});

test("identical filters are duplicates, not an N+1", async () => {
  const restore = instrumentMongodb({ Collection: FakeCollection });
  const findings: Finding[] = [];
  configure({ threshold: 3, duplicateThreshold: 2, onFinding: (f) => findings.push(f) });

  const users = new FakeCollection("users");
  await runInScope("same-filter", async () => {
    for (let i = 0; i < 5; i++) {
      await users.findOne({ _id: 7 });
    }
  });

  restore();
  assert.deepEqual(findings.filter((f) => f.type === "n_plus_one"), []);
  assert.equal(findings.filter((f) => f.type === "duplicate").length, 1);
});

test("instruments a single collection", async () => {
  const users = new FakeCollection("users");
  const restore = instrumentMongoCollection(users);
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });

  await runInScope("single", async () => {
    for (let i = 0; i < 4; i++) await users.findOne({ _id: i });
  });

  restore();
  assert.equal(findings.length, 1);
});

test("restoring stops the recording", async () => {
  const restore = instrumentMongodb({ Collection: FakeCollection });
  restore();
  configure({ threshold: 2 });

  const users = new FakeCollection("users");
  let count = -1;
  await runInScope("after-restore", async (scope) => {
    for (let i = 0; i < 4; i++) await users.findOne({ _id: i });
    count = scope.queryCount;
  });

  assert.equal(count, 0);
});

test("rejects a module without Collection", () => {
  assert.throws(() => instrumentMongodb({}), /expected the mongodb module/);
});
