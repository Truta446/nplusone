import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import { instrumentIoredis, normalizeRedisKey } from "../src/adapters/ioredis.js";

/**
 * ioredis.
 *
 * Two kinds of test here, on purpose:
 *
 * - A **shape** test against the real `ioredis`, which pins the two assumptions
 *   the adapter rests on: that every command funnels through
 *   `Redis.prototype.sendCommand`, and that a pipeline queues into `_queue` and
 *   flushes through `exec`. If a future ioredis moves either, this file fails
 *   rather than the adapter quietly recording nothing.
 * - **Behaviour** tests against a fake built to that shape, so no Redis server
 *   is needed anywhere.
 */

interface FakeCommand {
  name: string;
  args: unknown[];
}

class FakePipeline {
  _queue: FakeCommand[] = [];

  constructor(private readonly client: FakeRedis) {}

  push(name: string, ...args: unknown[]): this {
    this._queue.push({ name, args });
    return this;
  }

  exec(): Promise<unknown[]> {
    // The real Pipeline sends each queued command through the client, which is
    // exactly why the adapter has to mark them.
    for (const command of this._queue) this.client.sendCommand(command);
    return Promise.resolve([]);
  }
}

class FakeRedis {
  sendCommand(_command: FakeCommand): Promise<unknown> {
    return Promise.resolve(null);
  }

  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }

  multi(): FakePipeline {
    return new FakePipeline(this);
  }

  /** Convenience, so a test reads like application code. */
  run(name: string, ...args: unknown[]): Promise<unknown> {
    return this.sendCommand({ name, args });
  }
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true, threshold: 5 });
});

// ── the assumptions, pinned against the real library ─────────────────

test("ioredis still funnels every command through sendCommand", () => {
  const Client = (Redis as unknown as { default?: unknown }).default ?? Redis;
  const prototype = (Client as { prototype: Record<string, unknown> }).prototype;

  assert.equal(typeof prototype["sendCommand"], "function");
  assert.equal(typeof prototype["pipeline"], "function");
  assert.equal(typeof prototype["multi"], "function");
});

test("an ioredis pipeline still queues into _queue and shares a prototype with multi", () => {
  const Client = ((Redis as unknown as { default?: unknown }).default ??
    Redis) as new (options: { lazyConnect: boolean }) => {
    pipeline: () => { get: (key: string) => void };
    multi: () => object;
    disconnect: () => void;
  };
  const client = new Client({ lazyConnect: true });
  try {
    const pipeline = client.pipeline();
    pipeline.get("product:1");
    pipeline.get("product:2");

    const queue = (pipeline as unknown as { _queue: { name: string; args: unknown[] }[] })._queue;
    assert.equal(queue.length, 2);
    assert.equal(queue[0]?.name, "get");
    assert.deepEqual(queue[0]?.args, ["product:1"]);
    assert.equal(
      Object.getPrototypeOf(client.multi()),
      Object.getPrototypeOf(pipeline),
      "multi() must share the pipeline prototype, or one patch would miss it",
    );
  } finally {
    client.disconnect();
  }
});

// ── key normalization ────────────────────────────────────────────────

test("a colon-delimited key keeps its shape and loses its id", () => {
  assert.equal(normalizeRedisKey("product:1"), "product:*");
  assert.equal(normalizeRedisKey("user:42:sessions"), "user:*:sessions");
  assert.equal(
    normalizeRedisKey("session:9f8b7a6c5d4e3f21"),
    "session:*",
    "a long hex token is an id",
  );
});

test("a key with no delimiter is left alone, which is the documented limit", () => {
  assert.equal(normalizeRedisKey("abc1"), "abc1");
  assert.equal(normalizeRedisKey("counter"), "counter");
});

test("a word segment is not mistaken for an id", () => {
  assert.equal(normalizeRedisKey("cache:orders:index"), "cache:orders:index");
});

// ── behaviour ────────────────────────────────────────────────────────

test("detects a loop of GETs against a cache", async () => {
  const restore = instrumentIoredis(FakeRedis as never);
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  const redis = new FakeRedis();
  await runInScope("GET /products", async (scope) => {
    for (let id = 0; id < 7; id++) await redis.run("get", `product:${id}`);

    assert.equal(scope.queries[0]?.sql, "GET product:*");
    assert.equal(scope.queries[0]?.kind, "select");
    assert.deepEqual(scope.queries[0]?.params, ["product:0"]);
  });

  restore();
  assert.equal(findings.find((f) => f.type === "n_plus_one")?.count, 7);
});

test("a pipeline is one batch, not an N+1 — batching is the fix", async () => {
  const restore = instrumentIoredis(FakeRedis as never);
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  const redis = new FakeRedis();
  await runInScope("pipelined", async (scope) => {
    const pipeline = redis.pipeline();
    for (let id = 0; id < 20; id++) pipeline.push("get", `product:${id}`);
    await pipeline.exec();

    // Twenty statements, and each recorded exactly once — the real Pipeline
    // re-sends every queued command through the client, so a naive patch would
    // have counted forty.
    assert.equal(scope.queryCount, 20);
  });

  restore();
  // Recorded as a batch, so nothing is blamed on a loop: a batch is one round
  // trip, which is what someone fixing an N+1 is told to write.
  const nPlusOne = findings.find((f) => f.type === "n_plus_one");
  assert.equal(nPlusOne, undefined, "a pipeline must never be reported as an N+1");
});

test("a key survives into the report unmangled", async () => {
  // SQL normalization reads `:sessions` as a named bind and rewrites it to `?`.
  // The key is what the reader is meant to act on, so the adapter normalizes it
  // itself and the scope leaves it alone.
  const restore = instrumentIoredis(FakeRedis as never);
  const redis = new FakeRedis();

  await runInScope("readable", async (scope) => {
    await redis.run("hgetall", "user:42:sessions");
    assert.equal(scope.queries[0]?.normalized, "HGETALL user:*:sessions");
  });

  restore();
});

test("multi() goes through the same path", async () => {
  const restore = instrumentIoredis(FakeRedis as never);
  const redis = new FakeRedis();

  await runInScope("multi", async (scope) => {
    const tx = redis.multi();
    tx.push("set", "a:1", "x").push("set", "a:2", "y");
    await tx.exec();
    assert.equal(scope.queryCount, 2);
    assert.equal(scope.queries[0]?.kind, "insert");
  });

  restore();
});

test("bookkeeping and blocking commands are not recorded", async () => {
  const restore = instrumentIoredis(FakeRedis as never);
  const redis = new FakeRedis();

  await runInScope("bookkeeping", async (scope) => {
    await redis.run("ping");
    await redis.run("auth", "hunter2");
    await redis.run("select", "3");
    await redis.run("subscribe", "channel");
    await redis.run("brpop", "queue", "0");
    assert.equal(scope.queryCount, 0);

    await redis.run("get", "product:1");
    assert.equal(scope.queryCount, 1);
  });

  restore();
});

test("writes are classified, so a loop of SETs reads as a write", async () => {
  const restore = instrumentIoredis(FakeRedis as never);
  const redis = new FakeRedis();

  await runInScope("writes", async (scope) => {
    await redis.run("set", "product:1", "x");
    await redis.run("del", "product:1");
    await redis.run("incr", "counter:hits");
    assert.deepEqual(
      scope.queries.map((q) => q.kind),
      ["insert", "delete", "update"],
    );
  });

  restore();
});

test("instrumenting twice does not double count, and restore puts it back", async () => {
  const original = FakeRedis.prototype.sendCommand;
  const restoreA = instrumentIoredis(FakeRedis as never);
  const restoreB = instrumentIoredis(FakeRedis as never);

  const redis = new FakeRedis();
  await runInScope("twice", async (scope) => {
    await redis.run("get", "product:1");
    assert.equal(scope.queryCount, 1);
  });

  restoreB();
  restoreA();
  assert.equal(FakeRedis.prototype.sendCommand, original);
});

test("rejects something that is not the ioredis class", () => {
  assert.throws(() => instrumentIoredis({} as never), /expected the ioredis Redis class/);
});
