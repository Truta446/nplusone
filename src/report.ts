import type { Finding, ScopeSummary } from "./types.js";
import { formatCallSite } from "./callsite.js";
import { truncateSql } from "./normalize.js";

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

// Exported for tests that mutate process.env or process.stderr.isTTY.
// Call before each test that needs a fresh read.
export function _resetColorState(): void {
  // The color functions always re-read env, so nothing to reset.
  // This function exists so tests can coordinate cache invalidation
  // if a cached variant is ever reintroduced.
}

function headline(finding: Finding): string {
  return finding.type === "n_plus_one"
    ? c.red(`N+1 query`)
    : c.yellow(`Duplicate query`);
}

/** One finding as an indented block, without a trailing newline. */
export function formatFinding(finding: Finding): string {
  const lines: string[] = [];
  const times = c.bold(`${finding.count}×`);

  lines.push(`  ${headline(finding)}  ${times} ${truncateSql(finding.normalized)}`);
  lines.push(`     ${c.dim("at")} ${c.cyan(formatCallSite(finding.callsite))}`);

  if (finding.totalDurationMs !== undefined) {
    lines.push(`     ${c.dim(`${finding.totalDurationMs.toFixed(1)}ms spent here`)}`);
  }

  if (finding.type === "duplicate") {
    lines.push(
      `     ${c.dim("identical parameters — the repeats returned the same rows")}`,
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
  process.stderr.write(formatSummary(summary) + "\n\n");
}
