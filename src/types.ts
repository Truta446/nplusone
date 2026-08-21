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
  /**
   * Where the query builder was constructed, when an ORM adapter could tell
   * that apart from the line that executed it. Undefined when they are the
   * same place or when no ORM adapter was involved.
   */
  builtAt: CallSite | undefined;
  /** Milliseconds between the scope opening and this query starting. */
  offsetMs: number;
  /** How long the query took, when the adapter reports it. */
  durationMs: number | undefined;
}

export type FindingType =
  /** The same query shape ran repeatedly from one line of code. */
  | "n_plus_one"
  /** The exact same query *with the same values* ran more than once. */
  | "duplicate"
  /** The scope issued more queries than its budget allows. */
  | "too_many_queries";

/** One statement's share of a scope's query budget. */
export interface StatementCount {
  normalized: string;
  count: number;
}

export interface Finding {
  type: FindingType;
  /**
   * How many times it ran — for `too_many_queries`, how many queries the scope
   * issued in total. Kept up to date until the scope closes.
   */
  count: number;
  normalized: string;
  /** One of the actual statements, for display. */
  sample: string;
  kind: StatementKind;
  /**
   * The line to go and look at. Always undefined for `too_many_queries`: no
   * single line is to blame when the problem is the total.
   */
  callsite: CallSite | undefined;
  /**
   * Where the query builder was constructed, when that differs from
   * {@link callsite} — a repository helper, typically, with the loop that
   * matters in `callsite`.
   */
  builtAt: CallSite | undefined;
  /** Name of the scope it was found in, e.g. `GET /orders`. */
  scope: string;
  /** Summed duration of the repeated queries, when adapters report it. */
  totalDurationMs: number | undefined;
  /**
   * For `too_many_queries`: where the budget went, most frequent first.
   * Undefined for every other finding type.
   */
  breakdown: readonly StatementCount[] | undefined;
  /**
   * A sample of the distinct parameter sets that made this an N+1, serialized
   * for display and truncated. Populated only when `sampleValues` is on and the
   * driver reported parameters; always undefined for other finding types.
   */
  values: readonly string[] | undefined;
}

export interface ScopeSummary {
  name: string;
  /**
   * True when no scope was opened by the application and one was inferred from
   * a burst of queries. Counts from an inferred scope are approximate.
   */
  inferred: boolean;
  queryCount: number;
  durationMs: number;
  findings: readonly Finding[];
  /**
   * Every query recorded in the scope, in order (capped — see the scope's
   * retention limit). A reporter needs these to explain a request that is
   * expensive without anything repeating.
   */
  queries: readonly RecordedQuery[];
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
  /**
   * Also count `BEGIN`, `COMMIT`, `SET` and friends. Off by default: an ORM
   * emits one pair per write, which reads as duplicated work while being
   * ordinary bookkeeping.
   */
  includeTransactionControl?: boolean;
  /**
   * Group queries that arrive with no scope into an inferred one, closed after
   * a short idle gap.
   *
   * Off by default, and deliberately so. It is a **heuristic**: queries from
   * concurrent requests can land in the same inferred scope and inflate the
   * counts. It exists so that a first run shows something instead of nothing —
   * for a measurement you can trust, and for CI, open a real scope.
   */
  autoScope?: boolean;
  /**
   * How long an inferred scope waits for another query before closing, in
   * milliseconds. Default `50`, which is long enough to hold one request's
   * burst together and short enough to separate two of them.
   */
  autoScopeIdleMs?: number;
  /**
   * Report a scope that issues more than this many queries, even when nothing
   * repeats. Not every expensive request has an N+1 in it — fourteen different
   * statements to render one page is worth knowing about too.
   *
   * Off by default, so upgrading never adds noise. The finding is reported but
   * never thrown, whatever `mode` says: the check runs when the scope closes,
   * which for a request is inside a `finally` or a `finish` handler, and
   * throwing from there would replace a real error or crash the process. To
   * fail a test on a budget, use `expectQueryCount()`.
   */
  maxQueries?: number;
  /**
   * Show up to this many of the differing values on an N+1 finding, so it can
   * be reproduced. `0` — the default — shows none.
   *
   * **Off by default on purpose.** Parameters are exactly where email
   * addresses, tokens and personal data live, and this report goes to stderr
   * and from there into CI logs. Everything else the reporter prints is either
   * your own source location or SQL with its literals already replaced by `?`.
   * This is the one option that puts real data in the output, so turning it on
   * is a decision you make rather than one an upgrade makes for you.
   */
  sampleValues?: number;
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
  includeTransactionControl: boolean;
  autoScope: boolean;
  autoScopeIdleMs: number;
  maxQueries: number | undefined;
  sampleValues: number;
}
