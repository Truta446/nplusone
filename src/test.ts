/**
 * Test helpers.
 *
 * This is the part that keeps N+1s from coming back. A detector you have to
 * remember to look at decays; an assertion in the suite does not.
 */

import { configure, getOptions, restoreConfig } from "./config.js";
import { runInScope, type Scope } from "./scope.js";
import { formatFinding } from "./report.js";
import type { Finding, Options, RecordedQuery, ScopeSummary } from "./types.js";

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
 */
export async function expectNoNPlusOne(
  fn: () => unknown | Promise<unknown>,
  options: AssertOptions = {},
): Promise<CaptureResult> {
  const { includeDuplicates = false, name = "this block", ...rest } = options;

  const result = await captureQueries(fn, { ...rest, name });
  // `too_many_queries` is never included, even with `includeDuplicates`: it is
  // a budget, not a repetition, and `expectQueryCount()` is the assertion for
  // it. Folding it in here would make this helper fail for a reason its name
  // does not describe.
  const relevant = result.findings.filter(
    (f) => f.type === "n_plus_one" || (includeDuplicates && f.type === "duplicate"),
  );

  if (relevant.length > 0) {
    throw new NPlusOneAssertionError(relevant, name);
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
