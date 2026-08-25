import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@opensearch-project/opensearch";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import {
  instrumentOpenSearch,
  normalizeSearchPath,
} from "../src/adapters/opensearch.js";

/**
 * OpenSearch.
 *
 * The adapter rests on one claim: every API call funnels through
 * `transport.request({ method, path, body, querystring })`. That is pinned
 * against the real client below, so a future release that changes it fails this
 * file rather than leaving the adapter silently recording nothing. The
 * behaviour tests then use a fake transport, so no cluster is needed.
 */

class FakeTransport {
  calls: unknown[] = [];

  request(params: unknown, _options?: unknown): Promise<{ body: unknown }> {
    this.calls.push(params);
    return Promise.resolve({ body: {} });
  }
}

function fakeClient(): { transport: FakeTransport } {
  return { transport: new FakeTransport() };
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true, threshold: 5 });
});

// ── the assumption, pinned against the real client ───────────────────

test("the real client still funnels its API through transport.request", () => {
  const client = new Client({ node: "http://localhost:9200" });

  assert.equal(typeof client.transport, "object");
  assert.equal(
    typeof (client.transport as unknown as { request: unknown }).request,
    "function",
  );
  // The API methods are own properties on the instance, which is why there is
  // no prototype to patch and why the transport is the only viable funnel.
  assert.ok(Object.hasOwn(client, "search"));
  assert.equal(
    "search" in Object.getPrototypeOf(client),
    false,
    "if the API moves onto the prototype, reconsider where this patches",
  );
});

// ── path normalization ───────────────────────────────────────────────

test("a document id is replaced, so a loop groups", () => {
  assert.equal(normalizeSearchPath("/products/_doc/123"), "/products/_doc/*");
  assert.equal(normalizeSearchPath("/products/_doc/abc-987"), "/products/_doc/*");
  assert.equal(
    normalizeSearchPath("/products/_doc/123/_source"),
    "/products/_doc/*/_source",
  );
});

test("an index name and an API segment survive", () => {
  assert.equal(normalizeSearchPath("/products/_search"), "/products/_search");
  assert.equal(normalizeSearchPath("/_msearch"), "/_msearch");
  assert.equal(normalizeSearchPath("/orders,customers/_search"), "/orders,customers/_search");
});

test("a dated index is not collapsed, because those really are different indices", () => {
  assert.equal(
    normalizeSearchPath("/logs-2026.08.01/_search"),
    "/logs-2026.08.01/_search",
  );
});

// ── behaviour ────────────────────────────────────────────────────────

test("detects a get-per-hit loop", async () => {
  const client = fakeClient();
  const restore = instrumentOpenSearch(client);
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("GET /orders", async (scope) => {
    await client.transport.request({ method: "POST", path: "/orders/_search", body: { q: 1 } });
    for (let id = 0; id < 7; id++) {
      await client.transport.request({ method: "GET", path: `/customers/_doc/${id}` });
    }

    assert.equal(scope.queries[1]?.sql, "GET /customers/_doc/*");
    assert.equal(scope.queries[1]?.kind, "select");
  });

  restore();
  const finding = findings.find((f) => f.type === "n_plus_one");
  assert.equal(finding?.count, 7);
  assert.equal(finding?.normalized, "GET /customers/_doc/*");
});

test("a search-per-item loop is caught, which needs the body to discriminate", async () => {
  // The path is byte-identical on every iteration here. Without the request
  // body there would be nothing varying, and the most common shape of this bug
  // against a search engine would go unreported.
  const client = fakeClient();
  const restore = instrumentOpenSearch(client);
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("searches", async () => {
    for (let id = 0; id < 7; id++) {
      await client.transport.request({
        method: "POST",
        path: "/orders/_search",
        body: { query: { term: { customer_id: id } } },
      });
    }
  });

  restore();
  assert.equal(findings.find((f) => f.type === "n_plus_one")?.count, 7);
});

test("_msearch is one request and is never reported as repeated work", async () => {
  const client = fakeClient();
  const restore = instrumentOpenSearch(client);
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("msearch", async (scope) => {
    await client.transport.request({
      method: "POST",
      path: "/orders/_msearch",
      body: Array.from({ length: 50 }, (_u, i) => ({ query: { term: { id: i } } })),
    });

    assert.equal(scope.queryCount, 1, "one request on the wire is one query");
    assert.equal(scope.queries[0]?.kind, "select");
  });

  restore();
  assert.equal(findings.length, 0);
});

test("methods and endpoints are classified", async () => {
  const client = fakeClient();
  const restore = instrumentOpenSearch(client);

  await runInScope("kinds", async (scope) => {
    await client.transport.request({ method: "PUT", path: "/orders/_doc/1", body: { a: 1 } });
    await client.transport.request({ method: "POST", path: "/orders/_update/1", body: { a: 1 } });
    await client.transport.request({ method: "DELETE", path: "/orders/_doc/1" });
    await client.transport.request({ method: "POST", path: "/orders/_count", body: {} });

    assert.deepEqual(
      scope.queries.map((q) => q.kind),
      ["insert", "update", "delete", "select"],
    );
  });

  restore();
});

test("a request with nothing varying reports no parameters", async () => {
  const client = fakeClient();
  const restore = instrumentOpenSearch(client);

  await runInScope("bare", async (scope) => {
    await client.transport.request({ method: "GET", path: "/_cluster/health" });
    assert.equal(scope.queries[0]?.params, undefined);
  });

  restore();
});

test("the original request still receives its arguments and returns its result", async () => {
  const client = fakeClient();
  const restore = instrumentOpenSearch(client);

  await runInScope("passthrough", async () => {
    const options = { maxRetries: 2 };
    const result = await client.transport.request(
      { method: "GET", path: "/orders/_doc/1" },
      options,
    );
    assert.deepEqual(result, { body: {} });
    assert.deepEqual(client.transport.calls, [{ method: "GET", path: "/orders/_doc/1" }]);
  });

  restore();
});

test("instrumenting twice does not double count, and restore puts it back", async () => {
  const client = fakeClient();
  const original = client.transport.request;

  const restoreA = instrumentOpenSearch(client);
  const restoreB = instrumentOpenSearch(client);

  await runInScope("twice", async (scope) => {
    await client.transport.request({ method: "GET", path: "/orders/_doc/1" });
    assert.equal(scope.queryCount, 1);
  });

  restoreB();
  restoreA();
  assert.equal(client.transport.request, original);
});

test("rejects something that is not a client", () => {
  assert.throws(() => instrumentOpenSearch({}), /expected an OpenSearch client/);
  assert.throws(
    () => instrumentOpenSearch({ transport: {} }),
    /expected the client's transport to have a request/,
  );
});
