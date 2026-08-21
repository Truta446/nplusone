/**
 * What the detector costs per query (#16).
 *
 * The README used to claim that stack capture "is the main cost" without a
 * number anywhere in the repo. This produces the number. It matters more since
 * 0.6.0, which captures a stack on every *chained* call rather than once per
 * query, to fix attribution for helper-built queries (#12).
 *
 * Method: warm up, then take the median of several samples. A median rather
 * than a mean because one GC pause in one sample should not decide the answer.
 * Each sample runs in its own scope, so a growing bucket map is not silently
 * folded into the cost of the last case measured.
 *
 * This is a script, not a CI gate. Shared runners are far too noisy to fail a
 * build on, and a flaky perf gate gets disabled within a week.
 */

import { configure, resetConfig, runInScopeSync, record } from "../dist/index.js";
import { instrumentDrizzle } from "../dist/adapters/drizzle.js";
import { originNow } from "../dist/adapters/shared.js";

const ITERATIONS = 20_000;
const SAMPLES = 9;
const WARMUP = 3;

const SQL = "SELECT * FROM order_items WHERE order_id = $1";

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Nanoseconds per query, median of `SAMPLES` runs after `WARMUP` throwaways. */
function measure(run) {
  const perQuery = [];
  for (let sample = 0; sample < SAMPLES + WARMUP; sample++) {
    // A fresh scope per sample: buckets grow, and a scope carried across
    // samples would make later ones look slower for the wrong reason.
    const started = process.hrtime.bigint();
    runInScopeSync("bench", () => {
      for (let i = 0; i < ITERATIONS; i++) run(i);
    });
    const elapsed = Number(process.hrtime.bigint() - started);
    if (sample >= WARMUP) perQuery.push(elapsed / ITERATIONS);
  }
  return median(perQuery);
}

/**
 * Mimics a Drizzle chain: a lazy thenable with four building calls before
 * execution, which is what the 0.6.0 attribution fix has to walk.
 */
function fakeDrizzle() {
  class Builder {
    #params = [];
    from() { return this; }
    where(v) { this.#params = [v]; return this; }
    orderBy() { return this; }
    limit() { return this; }
    then(onFulfilled) {
      const origin = originNow();
      record({ sql: SQL, params: this.#params, callsite: origin.callsite, builtAt: origin.builtAt });
      return Promise.resolve([]).then(onFulfilled);
    }
  }
  return { select: () => new Builder() };
}

// Thresholds high enough that nothing is ever reported: this measures the
// recording path, not the reporting path.
const QUIET = { mode: "silent", enabled: true, threshold: 1e9, duplicateThreshold: 1e9 };

const cases = [
  {
    label: "detector disabled",
    note: "the floor — what a no-op record() costs",
    setup: () => configure({ ...QUIET, enabled: false }),
    run: (i) => record({ sql: SQL, params: [i % 50] }),
  },
  {
    label: "captureStack: false",
    note: "detection without attribution",
    setup: () => configure({ ...QUIET, captureStack: false }),
    run: (i) => record({ sql: SQL, params: [i % 50] }),
  },
  {
    label: "captureStack: true (default)",
    note: "stackDepth 30, the shipped default",
    setup: () => configure({ ...QUIET, captureStack: true, stackDepth: 30 }),
    run: (i) => record({ sql: SQL, params: [i % 50] }),
  },
  {
    label: "captureStack, stackDepth: 8",
    note: "a shallower walk, for comparison",
    setup: () => configure({ ...QUIET, captureStack: true, stackDepth: 8 }),
    run: (i) => record({ sql: SQL, params: [i % 50] }),
  },
];

console.log(
  `node ${process.version} · ${ITERATIONS.toLocaleString("en-US")} queries × ` +
    `${SAMPLES} samples (median)\n`,
);

const results = [];
for (const testCase of cases) {
  resetConfig();
  testCase.setup();
  results.push({ ...testCase, ns: measure(testCase.run) });
}

// The Drizzle chain is measured separately: one "query" here is four building
// calls plus an execution, so it is a per-query cost of a different shape.
resetConfig();
configure({ ...QUIET, captureStack: true });
const db = instrumentDrizzle(fakeDrizzle());
results.push({
  label: "instrumentDrizzle, 4-call chain",
  note: "one capture per chained call — the 0.6.0 attribution fix",
  ns: measure(() => {
    void db.select().from("items").where(1).orderBy("id").limit(10).then(() => {});
  }),
});

const floor = results[0].ns;
const pad = Math.max(...results.map((r) => r.label.length));

for (const result of results) {
  const over = result.ns - floor;
  const overText = result === results[0] ? "—" : `+${over.toFixed(0)} ns`;
  console.log(
    `  ${result.label.padEnd(pad)}  ${result.ns.toFixed(0).padStart(6)} ns/query   ` +
      `${overText.padStart(10)}   ${result.note}`,
  );
}

console.log(
  "\n  Numbers are per recorded query on one machine. Compare the gaps, not the\n" +
    "  absolutes — the absolutes move with hardware and Node version.",
);
