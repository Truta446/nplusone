/**
 * Regression tests for module duplication.
 *
 * Bundlers duplicate modules. Next.js compiles every route handler into its
 * own bundle, and a route can end up with a second copy of this library. When
 * that happened, the copy that patched the driver held one AsyncLocalStorage
 * and the copy that opened the request scope held another: the scope opened,
 * the queries ran, and the detector reported zero.
 *
 * These load the library twice through separate module URLs — which is what
 * gives two distinct module instances — and assert they still share state.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configure, resetConfig, getOptions } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Imports a module fresh, bypassing the cache with a unique query string. */
async function loadCopy(relative: string, tag: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(join(HERE, relative));
  url.searchParams.set("copy", tag);
  return (await import(url.href)) as Record<string, unknown>;
}

beforeEach(() => {
  resetConfig();
});

test("two copies of the module share one scope storage", async () => {
  // Copy A opens the scope, copy B records the query — exactly the split that
  // Next.js produces between the route bundle and the driver bundle.
  const a = (await loadCopy("../src/scope.js", "a")) as {
    runInScope: <T>(name: string, fn: () => T | Promise<T>) => Promise<T>;
  };
  const b = (await loadCopy("../src/scope.js", "b")) as {
    record: (input: { sql: string }) => unknown;
    getCurrentScope: () => { queryCount: number } | undefined;
  };

  configure({ enabled: true, mode: "silent", threshold: 1000 });

  let counted = -1;
  await a.runInScope("cross-copy", async () => {
    b.record({ sql: "SELECT * FROM t WHERE id = 1" });
    counted = b.getCurrentScope()?.queryCount ?? -1;
  });

  assert.equal(
    counted,
    1,
    "a scope opened by one copy must be visible to the other",
  );
});

test("two copies of the module share one configuration", async () => {
  const a = (await loadCopy("../src/config.js", "a")) as {
    configure: (o: Record<string, unknown>) => unknown;
  };
  const b = (await loadCopy("../src/config.js", "b")) as {
    getOptions: () => { threshold: number };
  };

  a.configure({ threshold: 42 });

  assert.equal(
    b.getOptions().threshold,
    42,
    "configuring through one copy must apply to the other",
  );
  // And the copy under test in this file sees it too.
  assert.equal(getOptions().threshold, 42);
});

test("two copies share the ambient call site", async () => {
  const a = (await loadCopy("../src/callsite-context.js", "a")) as {
    runWithCallSite: <T>(cs: unknown, fn: () => T) => T;
  };
  const b = (await loadCopy("../src/callsite-context.js", "b")) as {
    ambientCallSite: () => { file: string } | undefined;
  };

  const site = { file: "/app/orders.ts", line: 7, column: 3, function: "load" };
  const seen = a.runWithCallSite(site, () => b.ambientCallSite());

  assert.equal(
    seen?.file,
    "/app/orders.ts",
    "an ORM adapter in one copy must reach the driver adapter in the other",
  );
});
