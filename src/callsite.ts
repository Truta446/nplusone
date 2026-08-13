/**
 * Call site capture.
 *
 * Knowing that 50 identical queries ran is only half the report — the useful
 * half is the line of *your* code that fired them. We walk the stack and return
 * the first frame that belongs to the application rather than to a driver, an
 * ORM, or to this library.
 */

import { fileURLToPath } from "node:url";
import { dirname, relative, sep } from "node:path";

export interface CallSite {
  file: string;
  line: number;
  column: number;
  function: string | undefined;
}

/** Directory this library lives in, so its own frames can be skipped. */
const SELF_DIR = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
})();

const FRAME_RE = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

function toPath(file: string): string {
  if (file.startsWith("file://")) {
    try {
      return fileURLToPath(file);
    } catch {
      return file;
    }
  }
  return file;
}

function isInternal(file: string, ignore: readonly RegExp[]): boolean {
  if (file.startsWith("node:") || file.startsWith("internal/")) return true;
  if (file.includes(`${sep}node_modules${sep}`) || file.includes("/node_modules/")) return true;
  if (SELF_DIR !== "" && file.startsWith(SELF_DIR)) return true;
  return ignore.some((re) => re.test(file));
}

export interface CaptureOptions {
  /** Extra patterns whose frames should never be reported as the call site. */
  ignore?: readonly RegExp[];
  /** How deep to look before giving up. Higher costs more per query. */
  depth?: number;
}

/**
 * Returns the nearest application frame, or `undefined` when the whole stack is
 * library code (which happens when a query is issued from inside an ORM's own
 * internals with no user frame below it).
 */
export function captureCallSite(options: CaptureOptions = {}): CallSite | undefined {
  const ignore = options.ignore ?? [];
  const depth = options.depth ?? 30;

  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = depth;
  const stack = new Error().stack;
  Error.stackTraceLimit = previousLimit;

  if (stack === undefined) return undefined;

  const lines = stack.split("\n");
  for (const line of lines) {
    const m = FRAME_RE.exec(line);
    if (m === null) continue;

    const file = toPath(m[2]!);
    if (isInternal(file, ignore)) continue;

    const lineNo = Number.parseInt(m[3]!, 10);
    const colNo = Number.parseInt(m[4]!, 10);
    if (!Number.isFinite(lineNo)) continue;

    return { file, line: lineNo, column: colNo, function: m[1] };
  }

  return undefined;
}

/**
 * True when two sites point at the same line, ignoring the column.
 *
 * Grouping wants the column — two calls on one line are two calls. A reader
 * does not: telling someone a query was built at `orders.ts:61:31` and executed
 * at `orders.ts:61:44` is noise dressed as precision.
 */
export function sameLine(a: CallSite | undefined, b: CallSite | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.file === b.file && a.line === b.line;
}

/** A stable key for grouping — two queries from the same line share it. */
export function callSiteKey(site: CallSite | undefined): string {
  if (site === undefined) return "<unknown>";
  return `${site.file}:${site.line}:${site.column}`;
}

/** `src/routes/orders.ts:23` — relative to cwd when possible. */
export function formatCallSite(site: CallSite | undefined, cwd = process.cwd()): string {
  if (site === undefined) return "<unknown call site>";
  const rel = relative(cwd, site.file);
  const file = rel !== "" && !rel.startsWith("..") ? rel : site.file;
  const where = `${file}:${site.line}:${site.column}`;
  return site.function !== undefined ? `${where}  (${site.function})` : where;
}
