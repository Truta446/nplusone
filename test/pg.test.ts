import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import { instrumentPg, instrumentPgClient } from "../src/adapters/pg.js";

/** Stands in for pg.Client — same call signatures, no socket. */
class FakeClient {
  calls = 0;

  async query(
    _config: unknown,
    values?: unknown,
    callback?: (error: unknown, result: unknown) => void,
  ): Promise<{ rows: unknown[] }> {
    this.calls++;
    const result = { rows: [] };
    if (typeof values === "function") {
      (values as (e: unknown, r: unknown) => void)(null, result);
      return result;
    }
    if (typeof callback === "function") {
      callback(null, result);
      return result;
    }
    return result;
  }
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("records queries issued through the pg client", async () => {
  const fakePg = { Client: FakeClient };
  const restore = instrumentPg(fakePg);
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });

  const client = new FakeClient();
  const summary = await runInScope("GET /orders", async () => {
    for (let i = 0; i < 5; i++) {
      await client.query("SELECT * FROM items WHERE order_id = $1", [i]);
    }
  }).then(() => undefined);

  restore();
  assert.equal(summary, undefined);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.count, 5);
  assert.equal(client.calls, 5, "the real query still ran every time");
});

test("counts a pooled query once, not twice", async () => {
  // Pool.query delegates to Client.query. If both were patched every query
  // would be recorded twice and thresholds would fire at half the real count.
  class FakePool {
    constructor(private readonly client: FakeClient) {}
    async query(text: string, values?: unknown[]): Promise<unknown> {
      return this.client.query(text, values);
    }
  }

  const fakePg = { Client: FakeClient, Pool: FakePool };
  const restore = instrumentPg(fakePg);

  const client = new FakeClient();
  const pool = new FakePool(client);
  configure({ threshold: 1000 });

  let recorded = -1;
  await runInScope("pool", async (scope) => {
    await pool.query("SELECT 1", []);
    recorded = scope.queryCount;
  });

  restore();
  assert.equal(recorded, 1, "one pooled query should be recorded exactly once");
});

test("accepts the config-object call form", async () => {
  const client = new FakeClient();
  const restore = instrumentPgClient(client);
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });

  await runInScope("config-form", async () => {
    for (let i = 0; i < 4; i++) {
      await client.query({ text: "SELECT * FROM items WHERE order_id = $1", values: [i] });
    }
  });

  restore();
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.normalized, "SELECT * FROM items WHERE order_id = ?");
});

test("records callback-style queries too", async () => {
  const client = new FakeClient();
  const restore = instrumentPgClient(client);
  const findings: Finding[] = [];
  configure({ threshold: 3, onFinding: (f) => findings.push(f) });

  await runInScope("callback-form", async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => {
        void client.query("SELECT * FROM items WHERE order_id = $1", [i], () => resolve());
      });
    }
  });

  restore();
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.count, 4);
});

test("still records a query that rejects", async () => {
  class FailingClient {
    async query(_text: string, _values?: unknown[]): Promise<never> {
      throw new Error("connection lost");
    }
  }
  const client = new FailingClient();
  const restore = instrumentPgClient(client);
  const findings: Finding[] = [];
  configure({ threshold: 2, onFinding: (f) => findings.push(f) });

  await runInScope("failing", async () => {
    for (let i = 0; i < 3; i++) {
      await client.query("SELECT * FROM items WHERE order_id = $1", [i]).catch(() => {});
    }
  });

  restore();
  assert.equal(findings.length, 1);
});

test("restoring leaves the original method in place", async () => {
  const client = new FakeClient();
  const original = client.query;
  const restore = instrumentPgClient(client);
  assert.notEqual(client.query, original);
  restore();
  assert.equal(client.query, original);
});

test("instrumenting twice does not double count", async () => {
  const client = new FakeClient();
  const restoreA = instrumentPgClient(client);
  const restoreB = instrumentPgClient(client);
  const findings: Finding[] = [];
  configure({ threshold: 4, onFinding: (f) => findings.push(f) });

  await runInScope("double", async () => {
    for (let i = 0; i < 4; i++) {
      await client.query("SELECT * FROM items WHERE order_id = $1", [i]);
    }
  });

  restoreB();
  restoreA();
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.count, 4, "four calls should record four queries");
});

test("rejects a non-pg module with a clear message", () => {
  assert.throws(() => instrumentPg({}), /expected the pg module/);
});
