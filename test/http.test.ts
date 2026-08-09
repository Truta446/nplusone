import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  configure,
  resetConfig,
  record,
  getCurrentScope,
  type ScopeSummary,
} from "../src/index.js";
import { nplusoneMiddleware, withRequestScope } from "../src/http.js";

/** Minimal stand-in for an Express response: an emitter with finish/close. */
class FakeResponse extends EventEmitter {
  finish(): void {
    this.emit("finish");
  }
  abort(): void {
    this.emit("close");
  }
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("middleware opens a scope for the handler chain", async () => {
  const middleware = nplusoneMiddleware();
  const res = new FakeResponse();
  let scopeName: string | undefined;

  middleware({ method: "GET", url: "/orders" }, res, () => {
    scopeName = getCurrentScope()?.name;
  });

  assert.equal(scopeName, "GET /orders");
});

test("middleware reports when the response finishes", async () => {
  const summaries: ScopeSummary[] = [];
  configure({ threshold: 3, mode: "warn", reporter: (s) => summaries.push(s) });

  const middleware = nplusoneMiddleware();
  const res = new FakeResponse();

  middleware({ method: "GET", url: "/orders" }, res, () => {
    for (let i = 0; i < 4; i++) {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
    }
  });

  assert.equal(summaries.length, 0, "nothing is reported until the response ends");
  res.finish();

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.name, "GET /orders");
  assert.equal(summaries[0]!.queryCount, 4);
  assert.equal(summaries[0]!.findings.length, 1);
});

test("middleware closes the scope exactly once", () => {
  const summaries: ScopeSummary[] = [];
  configure({ threshold: 1, mode: "warn", reporter: (s) => summaries.push(s) });

  const middleware = nplusoneMiddleware();
  const res = new FakeResponse();

  middleware({ method: "GET", url: "/x" }, res, () => {
    record({ sql: "SELECT 1" });
    record({ sql: "SELECT 2" });
  });

  // Express emits both events on a normal request.
  res.finish();
  res.abort();
  res.finish();

  assert.equal(summaries.length, 1, "finish and close must not double report");
});

test("middleware reports on an aborted response too", () => {
  const summaries: ScopeSummary[] = [];
  configure({ threshold: 2, mode: "warn", reporter: (s) => summaries.push(s) });

  const middleware = nplusoneMiddleware();
  const res = new FakeResponse();

  middleware({ method: "GET", url: "/x" }, res, () => {
    for (let i = 0; i < 3; i++) record({ sql: "SELECT * FROM t WHERE id = $1", params: [i] });
  });
  res.abort();

  assert.equal(summaries.length, 1);
});

test("scope name prefers the route pattern over the concrete url", () => {
  const middleware = nplusoneMiddleware();
  const res = new FakeResponse();
  let name: string | undefined;

  middleware(
    { method: "GET", url: "/orders/12345", route: { path: "/orders/:id" } },
    res,
    () => {
      name = getCurrentScope()?.name;
    },
  );

  // Grouping by pattern keeps findings from splitting across every id.
  assert.equal(name, "GET /orders/:id");
});

test("scope name drops the query string", () => {
  const middleware = nplusoneMiddleware();
  const res = new FakeResponse();
  let name: string | undefined;

  middleware({ method: "GET", url: "/search?q=hello&page=2" }, res, () => {
    name = getCurrentScope()?.name;
  });

  assert.equal(name, "GET /search");
});

test("scope name honours originalUrl when a router rewrote url", () => {
  const middleware = nplusoneMiddleware();
  const res = new FakeResponse();
  let name: string | undefined;

  middleware({ method: "POST", url: "/items", originalUrl: "/api/v1/items" }, res, () => {
    name = getCurrentScope()?.name;
  });

  assert.equal(name, "POST /api/v1/items");
});

test("a custom namer overrides the default", () => {
  const middleware = nplusoneMiddleware({ name: (req) => `job:${req.method}` });
  const res = new FakeResponse();
  let name: string | undefined;

  middleware({ method: "GET", url: "/x" }, res, () => {
    name = getCurrentScope()?.name;
  });

  assert.equal(name, "job:GET");
});

test("middleware survives a response without event support", async () => {
  const middleware = nplusoneMiddleware();
  const summaries: ScopeSummary[] = [];
  configure({ threshold: 1, mode: "warn", reporter: (s) => summaries.push(s) });

  let ran = false;
  middleware({ method: "GET", url: "/x" }, {}, () => {
    ran = true;
    record({ sql: "SELECT 1" });
    record({ sql: "SELECT 1" });
  });

  assert.ok(ran, "the handler chain still runs");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(summaries.length, 1, "the scope closes on the microtask fallback");
});

test("the scope survives async work inside the handler", async () => {
  const summaries: ScopeSummary[] = [];
  configure({ threshold: 3, mode: "warn", reporter: (s) => summaries.push(s) });

  const middleware = nplusoneMiddleware();
  const res = new FakeResponse();

  let done: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  middleware({ method: "GET", url: "/orders" }, res, async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1));
      // Still attributed to the request despite crossing await boundaries.
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
    }
    res.finish();
    done?.();
  });

  await finished;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.queryCount, 4);
  assert.equal(summaries[0]!.findings.length, 1);
});

// --- fetch-style handlers ---------------------------------------------------

test("withRequestScope names the scope from method and pathname", async () => {
  let name: string | undefined;
  const handler = withRequestScope(async (_request: { method: string; url: string }) => {
    name = getCurrentScope()?.name;
    return "ok";
  });

  const result = await handler({
    method: "GET",
    url: "http://localhost:3000/orders?page=2",
  });

  assert.equal(result, "ok");
  assert.equal(name, "GET /orders", "the query string is not part of the scope name");
});

test("withRequestScope tolerates a relative url", async () => {
  let name: string | undefined;
  const handler = withRequestScope(async (_request: { method: string; url: string }) => {
    name = getCurrentScope()?.name;
    return null;
  });

  await handler({ method: "POST", url: "/webhook" });
  assert.equal(name, "POST /webhook");
});

test("withRequestScope detects an N+1 and closes the scope", async () => {
  const summaries: ScopeSummary[] = [];
  configure({ threshold: 4, mode: "warn", reporter: (s) => summaries.push(s) });

  const handler = withRequestScope(async (_request: { method: string; url: string }) => {
    for (let i = 0; i < 5; i++) {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
    }
    return "done";
  });

  await handler({ method: "GET", url: "http://x/orders" });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.findings.length, 1);
  assert.equal(getCurrentScope(), undefined, "the scope does not leak past the handler");
});

test("withRequestScope closes the scope when the handler throws", async () => {
  const summaries: ScopeSummary[] = [];
  configure({ threshold: 2, mode: "warn", reporter: (s) => summaries.push(s) });

  const handler = withRequestScope(async (_request: { method: string; url: string }) => {
    // One call site, distinct values — the shape that counts as an N+1.
    for (let i = 0; i < 2; i++) {
      record({ sql: "SELECT * FROM t WHERE id = $1", params: [i] });
    }
    throw new Error("boom");
  });

  await assert.rejects(
    () => handler({ method: "GET", url: "http://x/fail" }),
    /boom/,
  );
  assert.equal(summaries.length, 1, "a failed request still reports what it ran");
});

test("concurrent fetch handlers keep separate scopes", async () => {
  const summaries: ScopeSummary[] = [];
  configure({ threshold: 5, mode: "warn", reporter: (s) => summaries.push(s) });

  const handler = withRequestScope(async (request: { method: string; url: string }) => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1));
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
    }
    return request.url;
  });

  await Promise.all([
    handler({ method: "GET", url: "http://x/a" }),
    handler({ method: "GET", url: "http://x/b" }),
  ]);

  // Three queries each, interleaved — under the threshold in both scopes.
  assert.deepEqual(summaries, []);
});
