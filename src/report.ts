import type { Finding, ScopeSummary } from "./types.js";
import { formatCallSite, sameLine } from "./callsite.js";
import { truncateSql } from "./normalize.js";

/**
 * Read on every call rather than once at import: output may be a terminal in
 * one process and a pipe in another, and a test needs to exercise both paths.
 */
function useColor(): boolean {
  return (
    process.env["NO_COLOR"] === undefined &&
    process.env["TERM"] !== "dumb" &&
    process.stderr.isTTY === true
  );
}

const c = {
  dim: (s: string) => (useColor() ? `\u001b[2m${s}\u001b[22m` : s),
  bold: (s: string) => (useColor() ? `\u001b[1m${s}\u001b[22m` : s),
  yellow: (s: string) => (useColor() ? `\u001b[33m${s}\u001b[39m` : s),
  red: (s: string) => (useColor() ? `\u001b[31m${s}\u001b[39m` : s),
  cyan: (s: string) => (useColor() ? `\u001b[36m${s}\u001b[39m` : s),
};

function headline(finding: Finding): string {
  return finding.type === "n_plus_one"
    ? c.red(`N+1 query`)
    : c.yellow(`Duplicate query`);
}

/**
 * The budget finding has no line to blame, so it gets its own layout: the total
 * and then where it went, rather than a call site and a single statement.
 */
function formatBudget(finding: Finding): string {
  const lines: string[] = [];

  lines.push(`  ${c.yellow("Query budget")}  ${c.bold(finding.normalized)}`);

  if (finding.totalDurationMs !== undefined) {
    lines.push(`     ${c.dim(`${finding.totalDurationMs.toFixed(1)}ms spent querying`)}`);
  }

  // No `at` line: the finding is the total, and there is no one line to blame.
  // The breakdown is what tells the reader where the budget went.
  for (const row of finding.breakdown ?? []) {
    lines.push(`     ${c.bold(`${row.count}×`)} ${truncateSql(row.normalized, 88)}`);
  }

  return lines.join("\n");
}

export interface FormatOptions {
  /**
   * Render the count as a lower bound and say the loop may not be over.
   *
   * Set when printing at detection time. A finding is born the moment the
   * threshold is crossed — at 5 repetitions of a loop that may run 50 times —
   * and printing a flat `5×` for something that ended up running 50 times is
   * misleading in a way that is worse than being late.
   */
  provisional?: boolean;
}

/** One finding as an indented block, without a trailing newline. */
export function formatFinding(finding: Finding, options: FormatOptions = {}): string {
  if (finding.type === "too_many_queries") return formatBudget(finding);

  const lines: string[] = [];
  const times = c.bold(options.provisional ? `≥${finding.count}×` : `${finding.count}×`);

  lines.push(`  ${headline(finding)}  ${times} ${truncateSql(finding.normalized)}`);
  lines.push(`     ${c.dim("at")} ${c.cyan(formatCallSite(finding.callsite))}`);

  // Only when it adds something. A query built and run in the same place has
  // one origin, and printing it twice would read as two separate problems.
  if (finding.builtAt !== undefined && !sameLine(finding.builtAt, finding.callsite)) {
    lines.push(`     ${c.dim("built at")} ${c.dim(formatCallSite(finding.builtAt))}`);
  }

  if (finding.totalDurationMs !== undefined) {
    lines.push(`     ${c.dim(`${finding.totalDurationMs.toFixed(1)}ms spent here`)}`);
  }

  // The "1" in N+1, when there was a defensible candidate. Marked as a guess on
  // its own line: a reader who acts on it should know what it rests on.
  if (finding.parent !== undefined) {
    lines.push(
      `     ${c.dim("after")} ${c.bold("1×")} ${truncateSql(finding.parent.normalized, 88)}`,
    );
    lines.push(`     ${c.dim(`      at ${formatCallSite(finding.parent.callsite)}`)}`);
    lines.push(
      `     ${c.dim("a guess — the one read just before the loop. Join these, or fetch")}`,
    );
    lines.push(`     ${c.dim("the children in one query, if they are in fact related.")}`);
  }

  if (finding.values !== undefined && finding.values.length > 0) {
    const shown = finding.values.join(", ");
    const rest = finding.count - finding.values.length;
    lines.push(
      `     ${c.dim("values:")} ${shown}${rest > 0 ? c.dim(` … and ${rest} more`) : ""}`,
    );
  }

  if (finding.type === "duplicate") {
    lines.push(
      `     ${c.dim("identical parameters — the repeats returned the same rows")}`,
    );
  }

  if (options.provisional === true) {
    lines.push(
      `     ${c.dim("still counting — the total is reported when the scope closes")}`,
    );
  }

  return lines.join("\n");
}

/** The full report for a scope that produced at least one finding. */
export function formatSummary(summary: ScopeSummary): string {
  const lines: string[] = [];
  const n = summary.findings.length;

  lines.push(
    c.bold(`nplusone`) +
      ` ${n} ${n === 1 ? "finding" : "findings"} in ` +
      c.bold(summary.name) +
      c.dim(
        ` — ${summary.queryCount} ${summary.queryCount === 1 ? "query" : "queries"}` +
          `, ${summary.durationMs.toFixed(0)}ms`,
      ),
  );

  if (summary.inferred) {
    // Say it plainly. Counts from a guessed window are not a measurement, and
    // presenting them as one is how a heuristic loses people's trust.
    lines.push(
      c.dim(
        "  scope was inferred from a burst of queries — concurrent requests may be mixed in.",
      ),
    );
    lines.push(c.dim("  open a real scope for numbers you can rely on."));
  }

  for (const finding of summary.findings) {
    lines.push("");
    lines.push(formatFinding(finding));
  }

  return lines.join("\n");
}

export function defaultReporter(summary: ScopeSummary): void {
  process.stderr.write(`${formatSummary(summary)}\n\n`);
}

/**
 * Prints one finding at the moment it was detected, for
 * `reportWhen: "immediately"`.
 *
 * Deliberately not a summary: there is no scope total yet, and no list of
 * findings to head. What it is, is one problem that has just started happening,
 * with a count that is still going up — which the `≥` and the closing line say
 * out loud rather than leaving the reader to infer.
 */
export function reportFindingNow(finding: Finding): void {
  const header = `${c.bold("nplusone")} ${c.dim("live in")} ${c.bold(finding.scope)}`;
  process.stderr.write(
    `${header}\n${formatFinding(finding, { provisional: true })}\n\n`,
  );
}
