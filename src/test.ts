/**
 * Test helpers.
 *
 * This is the part that keeps N+1s from coming back. A detector you have to
 * remember to look at decays; an assertion in the suite does not.
 */

import { configure, getOptions, restoreConfig } from "./config.js";
import { runInScope, type Scope } from "./scope.js";
import { formatFinding } from "./report.js";
import { applyBaseline } from "./baseline.js";
import type { Finding, Options, RecordedQuery, ScopeSummary } from "./types.js";

export {
  applyBaseline,
  baselineEntry,
  baselineKey,
  flushBaselines,
  formatBaseline,
  parseBaseline,
  resetBaselines,
  updating,
  type BaselineEntry,
  type BaselineFile,
} from "./baseline.js";

export interface CaptureResult {
  findings: readonly Finding[];
  queries: readonly RecordedQuery[];
  summary: ScopeSummary;
}

/** Runs `fn` with the given options applied, restoring them afterwards. */
async function withOptions<T>(overrides: Options, fn: () => Promise<T>): Promise<T> {
  const previous = getOptions();
  configure(overrides);
  try {
    return await fn();
  } finally {
    restoreConfig(previous);
  }
}

/**
 * Runs `fn` in an isolated scope and returns everything observed, without
 * printing or throwing. Use it when you want to assert on the details.
 *
 * ```ts
 * const { queries } = await captureQueries(() => loadDashboard(userId));
 * assert.equal(queries.length, 3);
 * ```
 */
export async function captureQueries(
  fn: () => unknown | Promise<unknown>,
  options: Options & { name?: string } = {},
): Promise<CaptureResult> {
  const { name = "captureQueries", ...rest } = options;

  let scope: Scope | undefined;
  await withOptions({ ...rest, mode: "silent", enabled: true }, async () => {
    await runInScope(name, async (s) => {
      scope = s;
      await fn();
    });
  });

  // runInScope always assigns before fn runs, so this is unreachable in
  // practice; it keeps the types honest.
  if (scope === undefined) throw new Error("nplusone: scope was not created");

  return {
    findings: scope.findings,
    queries: scope.queries,
    summary: scope.summary(),
  };
}

export class NPlusOneAssertionError extends Error {
  override readonly name = "NPlusOneAssertionError";
  readonly findings: readonly Finding[];

  constructor(findings: readonly Finding[], label: string) {
    const body = findings.map((f) => formatFinding(f)).join("\n");
    super(
      `Expected no N+1 queries in ${label}, found ${findings.length}:\n\n${body}\n`,
    );
    this.findings = findings;
  }
}

export interface AssertOptions extends Options {
  /** Label used in the failure message. */
  name?: string;
  /** Also fail on duplicate queries. Default `false`. */
  includeDuplicates?: boolean;
  /**
   * Path to a baseline file of findings that are already known and tolerated.
   * New ones still fail.
   *
   * ```ts
   * await expectNoNPlusOne(() => renderOrdersPage(userId), {
   *   baseline: ".nplusone-baseline.json",
   * });
   * ```
   *
   * Write it — and add to it later — by running the suite with
   * `NPLUSONE_UPDATE_BASELINE=1`. That is deliberately the same shape as a
   * snapshot update rather than a `npx nplusone baseline` command: the findings
   * only exist while the suite runs, so anything else would have to re-run the
   * suite itself and guess at how.
   *
   * Entries the run never matched are reported at exit, so a baseline whose
   * N+1s have since been fixed does not rot in silence. That report is a
   * warning and never a failure.
   */
  baseline?: string;
  /**
   * Root that baseline paths are stored relative to. Default `process.cwd()`.
   * Set it when the suite runs from somewhere other than the project root, or
   * the file will only match on the machine that wrote it.
   */
  baselineRoot?: string;
}

/**
 * Fails when `fn` issues an N+1. Drop it into any test runner — it throws a
 * plain `Error`, so Jest, Vitest and `node:test` all report it correctly.
 *
 * ```ts
 * test("orders page does not N+1", async () => {
 *   await expectNoNPlusOne(() => renderOrdersPage(userId));
 * });
 * ```
 *
 * On a codebase that already has N+1s, {@link AssertOptions.baseline} freezes
 * the existing ones so the gate can be turned on today.
 */
export async function expectNoNPlusOne(
  fn: () => unknown | Promise<unknown>,
  options: AssertOptions = {},
): Promise<CaptureResult> {
  const {
    includeDuplicates = false,
    name = "this block",
    baseline,
    baselineRoot,
    ...rest
  } = options;

  const result = await captureQueries(fn, { ...rest, name });
  // `too_many_queries` is never included, even with `includeDuplicates`: it is
  // a budget, not a repetition, and `expectQueryCount()` is the assertion for
  // it. Folding it in here would make this helper fail for a reason its name
  // does not describe.
  const relevant = result.findings.filter(
    (f) => f.type === "n_plus_one" || (includeDuplicates && f.type === "duplicate"),
  );

  // Known debt is forgiven; anything the file does not list still fails. In
  // update mode this forgives everything and queues it for writing.
  const unknown =
    baseline === undefined ? relevant : applyBaseline(baseline, relevant, baselineRoot);

  if (unknown.length > 0) {
    throw new NPlusOneAssertionError(unknown, name);
  }
  return result;
}

/**
 * Fails when `fn` issues more than `max` queries. A blunter guard than
 * {@link expectNoNPlusOne}, and a good regression test for a hot endpoint.
 */
export async function expectQueryCount(
  fn: () => unknown | Promise<unknown>,
  max: number,
  options: Options & { name?: string } = {},
): Promise<CaptureResult> {
  const result = await captureQueries(fn, options);
  if (result.summary.queryCount > max) {
    const listed = result.queries
      .slice(0, 20)
      .map((q, i) => `  ${i + 1}. ${q.normalized}`)
      .join("\n");
    throw new Error(
      `Expected at most ${max} ${max === 1 ? "query" : "queries"}, got ` +
        `${result.summary.queryCount}:\n${listed}\n`,
    );
  }
  return result;
}
