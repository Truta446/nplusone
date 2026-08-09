import type { Finding } from "./types.js";
import { formatCallSite } from "./callsite.js";
import { truncateSql } from "./normalize.js";

/**
 * Thrown at the query that crosses the threshold when `mode: "throw"` is set.
 * This is what turns the detector from a debugging aid into a CI gate.
 */
export class NPlusOneError extends Error {
  override readonly name = "NPlusOneError";
  readonly finding: Finding;

  constructor(finding: Finding) {
    const what =
      finding.type === "n_plus_one"
        ? `N+1 query: the same statement ran ${finding.count} times`
        : `Duplicate query: an identical statement ran ${finding.count} times`;
    super(
      `${what} in "${finding.scope}"\n` +
        `  ${truncateSql(finding.normalized)}\n` +
        `  at ${formatCallSite(finding.callsite)}`,
    );
    this.finding = finding;
  }
}
