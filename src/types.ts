import type { CallSite } from "./callsite.js";
import type { StatementKind } from "./normalize.js";

export type { CallSite } from "./callsite.js";
export type { StatementKind } from "./normalize.js";

/** A single query execution observed inside a scope. */
export interface RecordedQuery {
  /** The statement as the driver received it. */
  sql: string;
  /** Literals and binds replaced by `?` — see {@link normalizeSql}. */
  normalized: string;
  kind: StatementKind;
  params: readonly unknown[] | undefined;
  callsite: CallSite | undefined;
  /** Milliseconds between the scope opening and this query starting. */
  offsetMs: number;
  /** How long the query took, when the adapter reports it. */
  durationMs: number | undefined;
}

export type FindingType =
  /** The same query shape ran repeatedly from one line of code. */
  | "n_plus_one"
  /** The exact same query *with the same values* ran more than once. */
  | "duplicate";

export interface Finding {
  type: FindingType;
  /** How many times it ran. Kept up to date until the scope closes. */
  count: number;
  normalized: string;
  /** One of the actual statements, for display. */
  sample: string;
  kind: StatementKind;
  callsite: CallSite | undefined;
  /** Name of the scope it was found in, e.g. `GET /orders`. */
  scope: string;
  /** Summed duration of the repeated queries, when adapters report it. */
  totalDurationMs: number | undefined;
}

export interface ScopeSummary {
  name: string;
  queryCount: number;
  durationMs: number;
  findings: readonly Finding[];
}

export type Mode = "warn" | "throw" | "silent";

export interface Options {
  /**
   * How many repetitions of one query shape from one call site count as an
   * N+1. Default `5` — low enough to catch real loops, high enough that a
   * couple of related lookups do not trip it.
   */
  threshold?: number;
  /**
   * How many executions of a byte-identical query (same SQL *and* same
   * parameters) count as a duplicate. Default `2`, since the second one is
   * already wasted work.
   */
  duplicateThreshold?: number;
  /**
   * What to do on detection. `warn` prints a report, `throw` raises an
   * {@link NPlusOneError} at the offending query — which is what makes a test
   * suite fail. Default `warn`.
   */
  mode?: Mode;
  /** Only consider these statement kinds. Default: all of them. */
  statements?: readonly StatementKind[];
  /** Queries whose SQL matches any of these are not recorded at all. */
  ignore?: readonly RegExp[];
  /** Frames matching these are never reported as the call site. */
  ignoreCallSites?: readonly RegExp[];
  /**
   * Capture a stack trace per query to attribute it to a line of code. This is
   * the main cost of running the detector; turning it off keeps detection but
   * loses the "which line" answer. Default `true`.
   */
  captureStack?: boolean;
  /** Stack frames to walk when attributing a query. Default `30`. */
  stackDepth?: number;
  /** Called once per finding, at the moment the threshold is crossed. */
  onFinding?: (finding: Finding) => void;
  /** Called when a scope closes with at least one finding. */
  reporter?: (summary: ScopeSummary) => void;
  /**
   * Master switch. Defaults to `process.env.NODE_ENV !== "production"`, so the
   * cost never lands on a production process unless you ask for it.
   */
  enabled?: boolean;
}

export interface ResolvedOptions {
  threshold: number;
  duplicateThreshold: number;
  mode: Mode;
  statements: readonly StatementKind[] | undefined;
  ignore: readonly RegExp[];
  ignoreCallSites: readonly RegExp[];
  captureStack: boolean;
  stackDepth: number;
  onFinding: ((finding: Finding) => void) | undefined;
  reporter: ((summary: ScopeSummary) => void) | undefined;
  enabled: boolean;
}
