/**
 * Automatic scoping.
 *
 * Missing the scope step is the number one reason someone concludes the library
 * does not work: it records nothing and prints a single warning. This mode
 * groups queries that arrive with no scope into an inferred one, closed after a
 * short idle gap.
 *
 * It is a heuristic and these tests treat it as one — including the case where
 * it gets the answer wrong, which is documented rather than pretended away.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  configure,
  resetConfig,
  record,
  runInScope,
  flushAutoScope,
  resetScopeWarning,
  type ScopeSummary,
} from "../src/index.js";

const IDLE = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let summaries: ScopeSummary[] = [];

beforeEach(() => {
  resetConfig();
  resetScopeWarning();
  summaries = [];
  configure({
    enabled: true,
    mode: "warn",
    autoScope: true,
    autoScopeIdleMs: IDLE,
    threshold: 3,
    reporter: (s) => summaries.push(s),
  });
});

afterEach(() => {
  flushAutoScope();
});

test("off by default, so nothing changes for existing users", () => {
  resetConfig();
  configure({ enabled: true, mode: "silent" });
  assert.equal(record({ sql: "SELECT 1" }), undefined);
});

test("groups a burst of queries and finds the N+1 in it", async () => {
  for (let i = 0; i < 5; i++) {
    record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
  }

  await sleep(IDLE * 3);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.queryCount, 5);
  assert.equal(summaries[0]!.findings.length, 1);
  assert.equal(summaries[0]!.findings[0]!.count, 5);
});

test("marks the scope as inferred, and says so in the report", async () => {
  for (let i = 0; i < 4; i++) {
    record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
  }
  await sleep(IDLE * 3);

  assert.equal(summaries[0]!.inferred, true);

  const { formatSummary } = await import("../src/report.js");
  const text = formatSummary(summaries[0]!);
  assert.match(text, /scope was inferred/);
  assert.match(text, /concurrent requests may be mixed in/);
});

test("a gap in traffic starts a new scope", async () => {
  record({ sql: "SELECT * FROM a WHERE id = $1", params: [1] });
  await sleep(IDLE * 3);
  record({ sql: "SELECT * FROM b WHERE id = $1", params: [1] });
  await sleep(IDLE * 3);

  assert.equal(summaries.length, 2, "two bursts should be two scopes");
  assert.notEqual(summaries[0]!.name, summaries[1]!.name);
  assert.equal(summaries[0]!.queryCount, 1);
  assert.equal(summaries[1]!.queryCount, 1);
});

test("the idle window is extended by each new query", async () => {
  // Five queries spaced under the window: they belong to one scope even though
  // the whole burst lasts longer than the window itself.
  for (let i = 0; i < 5; i++) {
    record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
    await sleep(IDLE / 2);
  }
  await sleep(IDLE * 3);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.queryCount, 5);
});

test("a real scope always wins over the inferred one", async () => {
  await runInScope("GET /orders", () => {
    for (let i = 0; i < 4; i++) {
      record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [i] });
    }
  });
  await sleep(IDLE * 3);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.name, "GET /orders");
  assert.equal(summaries[0]!.inferred, false, "an explicit scope is not a guess");
});

test("flushAutoScope closes the scope immediately", () => {
  record({ sql: "SELECT * FROM items WHERE order_id = $1", params: [1] });
  assert.equal(summaries.length, 0, "still open");

  flushAutoScope();

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.queryCount, 1);
});

test("the timer does not keep the process alive", () => {
  // Without unref(), a script or test suite would hang until the window
  // elapsed. Node exposes the flag on the handle itself.
  const before = process.getActiveResourcesInfo?.() ?? [];
  record({ sql: "SELECT 1" });
  const after = process.getActiveResourcesInfo?.() ?? [];

  assert.deepEqual(
    after.filter((r) => r === "Timeout"),
    before.filter((r) => r === "Timeout"),
    "the idle timer must be unref'd, so it is not an active resource",
  );
});

test("concurrent bursts land together — the documented weakness", async () => {
  // Not a bug being enshrined: this is the trade-off the mode exists to make,
  // and the report says the scope was inferred precisely because of it. If the
  // behaviour ever changes, this test should be updated deliberately.
  await Promise.all([
    (async () => {
      for (let i = 0; i < 2; i++) {
        record({ sql: "SELECT * FROM a WHERE id = $1", params: [i] });
        await sleep(1);
      }
    })(),
    (async () => {
      for (let i = 0; i < 2; i++) {
        record({ sql: "SELECT * FROM b WHERE id = $1", params: [i] });
        await sleep(1);
      }
    })(),
  ]);
  await sleep(IDLE * 3);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.queryCount, 4, "two requests, one inferred scope");
});

test("a short script still reports, despite the unref'd timer", async () => {
  // The two requirements pull against each other: unref so a process is never
  // held open, but a script that finishes inside the idle window would then
  // print nothing — which is the exact problem this mode exists to solve.
  // Resolved with a beforeExit flush. Verified in a child process, since the
  // test runner's own loop never empties.
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = mkdtempSync(join(tmpdir(), "nplusone-"));
  const entry = join(dir, "script.mjs");
  const lib = pathToFileURL(join(process.cwd(), "dist-test/src/index.js")).href;

  writeFileSync(
    entry,
    `import { configure, record } from ${JSON.stringify(lib)};\n` +
      `configure({ autoScope: true, threshold: 3 });\n` +
      `for (const id of [1,2,3,4]) record({ sql: "SELECT * FROM t WHERE id = $1", params: [id] });\n`,
  );

  const run = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 10_000 });

  assert.equal(run.status, 0, "the script must exit cleanly, not hang");
  assert.match(run.stderr, /1 finding in auto #/, "the burst must be reported on exit");
  assert.match(run.stderr, /scope was inferred/);
});
