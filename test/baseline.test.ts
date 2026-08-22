import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, record, resetConfig, runInScope } from "../src/index.js";
import type { Finding } from "../src/index.js";
import {
  applyBaseline,
  baselineEntry,
  baselineKey,
  expectNoNPlusOne,
  flushBaselines,
  formatBaseline,
  parseBaseline,
  resetBaselines,
  type BaselineEntry,
} from "../src/test.js";

/**
 * Baselines.
 *
 * The whole feature turns on the key: it has to survive an edit somewhere else
 * in the file and still tell two loops apart. Most of what follows is that
 * claim, tested from both sides.
 */

const dir = mkdtempSync(join(tmpdir(), "nplusone-baseline-"));
let counter = 0;

/** A fresh path per test, so nothing leaks between them. */
function tempPath(): string {
  counter += 1;
  return join(dir, `baseline-${counter}.json`);
}

function entry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    file: "src/routes/orders.ts",
    function: "loadOrders",
    sql: "SELECT * FROM items WHERE order_id = ?",
    type: "n_plus_one",
    count: 50,
    ...overrides,
  };
}

/** Seven repetitions of one shape, from one line, which is an N+1. */
function loop(): void {
  for (let id = 0; id < 7; id++) {
    record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
  }
}

beforeEach(() => {
  resetConfig();
  resetBaselines();
  configure({ threshold: 5, mode: "silent", enabled: true, captureStack: false });
  delete process.env["NPLUSONE_UPDATE_BASELINE"];
  delete process.env["NPLUSONE_BASELINE_STALE"];
});

// ── the key ──────────────────────────────────────────────────────────

test("the key ignores the line, so an edit elsewhere in the file does not stale it", () => {
  const before: Finding = {
    type: "n_plus_one",
    count: 50,
    normalized: "SELECT * FROM items WHERE order_id = ?",
    sample: "SELECT * FROM items WHERE order_id = 1",
    kind: "select",
    callsite: { file: join(dir, "orders.ts"), line: 38, column: 5, function: "loadOrders" },
    builtAt: undefined,
    scope: "GET /orders",
    totalDurationMs: undefined,
    breakdown: undefined,
    parent: undefined,
    values: undefined,
  };
  // Somebody added an import at the top of the file.
  const after: Finding = {
    ...before,
    callsite: { ...before.callsite!, line: 41, column: 9 },
  };

  assert.equal(
    baselineKey(baselineEntry(before, dir)),
    baselineKey(baselineEntry(after, dir)),
  );
});

test("the key separates two loops issuing the same statement", () => {
  assert.notEqual(
    baselineKey(entry({ function: "loadOrders" })),
    baselineKey(entry({ function: "loadInvoices" })),
  );
});

test("the count is not part of the key", () => {
  assert.equal(baselineKey(entry({ count: 10 })), baselineKey(entry({ count: 500 })));
});

test("a path outside the root is not keyed on an absolute path", () => {
  const finding = baselineEntry(
    {
      type: "n_plus_one",
      count: 2,
      normalized: "SELECT 1",
      sample: "SELECT 1",
      kind: "select",
      callsite: { file: "/somewhere/else/lib.ts", line: 1, column: 1, function: "f" },
      builtAt: undefined,
      scope: "s",
      totalDurationMs: undefined,
      breakdown: undefined,
      parent: undefined,
      values: undefined,
    },
    dir,
  );
  assert.equal(finding.file, "<unknown>");
});

// ── the file ─────────────────────────────────────────────────────────

test("the file is sorted, so re-running it produces no diff", () => {
  const a = formatBaseline([entry({ function: "b" }), entry({ function: "a" })]);
  const b = formatBaseline([entry({ function: "a" }), entry({ function: "b" })]);
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}/, "no timestamps");
});

test("a file that is not a baseline says how to fix it", () => {
  assert.throws(() => parseBaseline("{}", "x.json"), /is not a baseline file/);
  assert.throws(() => parseBaseline("nope", "x.json"), /is not valid JSON/);
  assert.throws(
    () => parseBaseline('{"version":1,"findings":[{"file":"a"}]}', "x.json"),
    /malformed entries/,
  );
});

// ── the gate ─────────────────────────────────────────────────────────

test("a baselined finding passes and a new one fails", async () => {
  const path = tempPath();

  // Record what exists today.
  process.env["NPLUSONE_UPDATE_BASELINE"] = "1";
  await expectNoNPlusOne(loop, { baseline: path, threshold: 5, captureStack: false });
  flushBaselines();
  delete process.env["NPLUSONE_UPDATE_BASELINE"];
  resetBaselines();

  const written = parseBaseline(readFileSync(path, "utf8"), path);
  assert.equal(written.findings.length, 1);
  assert.equal(written.findings[0]?.count, 7);

  // The same N+1 is now forgiven.
  await expectNoNPlusOne(loop, { baseline: path, threshold: 5, captureStack: false });

  // A different one is not.
  await assert.rejects(
    expectNoNPlusOne(
      () => {
        for (let id = 0; id < 7; id++) {
          record({ sql: `SELECT * FROM shipments WHERE order_id = ${id}` });
        }
      },
      { baseline: path, threshold: 5, captureStack: false },
    ),
    /shipments/,
  );
});

test("a missing baseline forgives nothing", async () => {
  await assert.rejects(
    expectNoNPlusOne(loop, { baseline: tempPath(), threshold: 5, captureStack: false }),
    /Expected no N\+1 queries/,
  );
});

test("update mode merges rather than rewriting, so a sharded run cannot clobber", () => {
  const path = tempPath();
  writeFileSync(path, formatBaseline([entry({ function: "fromAnotherWorker" })]), "utf8");

  process.env["NPLUSONE_UPDATE_BASELINE"] = "1";
  applyBaseline(
    path,
    [
      {
        type: "n_plus_one",
        count: 3,
        normalized: "SELECT * FROM shipments WHERE order_id = ?",
        sample: "SELECT * FROM shipments WHERE order_id = 1",
        kind: "select",
        callsite: { file: join(dir, "ship.ts"), line: 4, column: 1, function: "loadShipments" },
        builtAt: undefined,
        scope: "s",
        totalDurationMs: undefined,
        breakdown: undefined,
        parent: undefined,
        values: undefined,
      },
    ],
    dir,
  );
  flushBaselines();

  const written = parseBaseline(readFileSync(path, "utf8"), path);
  assert.equal(written.findings.length, 2);
  assert.ok(written.findings.some((f) => f.function === "fromAnotherWorker"));
  assert.ok(written.findings.some((f) => f.function === "loadShipments"));
});

test("an entry nothing matched is reported as stale, and does not fail the run", async () => {
  const path = tempPath();
  writeFileSync(path, formatBaseline([entry({ function: "longSinceFixed" })]), "utf8");

  // Nothing in this run matches it.
  await runInScope("clean", () => {
    record({ sql: "SELECT 1" });
  });
  applyBaseline(path, [], dir);

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    flushBaselines();
  } finally {
    process.stderr.write = original;
  }

  const output = written.join("");
  assert.match(output, /1 baseline entry/);
  assert.match(output, /longSinceFixed/);
  assert.match(output, /single-process run/, "the sharding caveat is stated");
});

test("a matched entry is not reported as stale", async () => {
  const path = tempPath();
  process.env["NPLUSONE_UPDATE_BASELINE"] = "1";
  await expectNoNPlusOne(loop, { baseline: path, threshold: 5, captureStack: false });
  flushBaselines();
  delete process.env["NPLUSONE_UPDATE_BASELINE"];
  resetBaselines();

  await expectNoNPlusOne(loop, { baseline: path, threshold: 5, captureStack: false });

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    flushBaselines();
  } finally {
    process.stderr.write = original;
  }

  assert.equal(written.join(""), "");
});

test("NPLUSONE_BASELINE_STALE=off silences the warning", () => {
  const path = tempPath();
  writeFileSync(path, formatBaseline([entry()]), "utf8");
  process.env["NPLUSONE_BASELINE_STALE"] = "off";
  applyBaseline(path, [], dir);

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    flushBaselines();
  } finally {
    process.stderr.write = original;
  }

  assert.equal(written.join(""), "");
});
