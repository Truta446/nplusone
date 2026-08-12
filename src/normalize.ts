/**
 * SQL normalization.
 *
 * Turns `SELECT * FROM items WHERE order_id = 42` and
 * `SELECT * FROM items WHERE order_id = 43` into the same shape, so repeated
 * executions of "the same query with different values" can be counted together.
 *
 * This is a scanner rather than a pile of regexes because literals have to be
 * recognized in context: a `--` inside a string is not a comment, and the `2`
 * in `col2` is not a number.
 */

const PLACEHOLDER = "?";

/** Characters that can appear inside an unquoted identifier. */
function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * Replaces literals and bind placeholders with `?`, strips comments, and
 * collapses whitespace. The result is stable across calls that differ only in
 * their values.
 */
export function normalizeSql(sql: string): string {
  const n = sql.length;
  let out = "";
  let i = 0;

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    // The character immediately before this one — including whitespace. It
    // tells a literal (`LIMIT 42`, `= 42`) apart from a digit that belongs to
    // an identifier (`col2`). Skipping whitespace here would make the `T` of
    // `LIMIT` swallow the number that follows it.
    const before = sql[i - 1];

    // -- line comment
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }

    // /* block comment */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }

    // 'string literal' — '' and \' both escape
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += PLACEHOLDER;
      continue;
    }

    // "quoted identifier" / `quoted identifier` — structural, keep verbatim
    if (ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = sql[i]!;
        out += c;
        i++;
        if (c === quote) {
          if (sql[i] === quote) {
            out += quote;
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // $tag$ dollar-quoted string $tag$ (PostgreSQL)
    if (ch === "$" && !isIdentChar(before)) {
      const close = sql.indexOf("$", i + 1);
      if (close !== -1) {
        const tag = sql.slice(i, close + 1); // e.g. "$$" or "$body$"
        if (/^\$[A-Za-z_]*\$$/.test(tag)) {
          const end = sql.indexOf(tag, close + 1);
          i = end === -1 ? n : end + tag.length;
          out += PLACEHOLDER;
          continue;
        }
      }
      // $1, $2 — numbered bind placeholder
      if (isDigit(next)) {
        i++;
        while (isDigit(sql[i])) i++;
        out += PLACEHOLDER;
        continue;
      }
    }

    // ? positional placeholder
    if (ch === "?") {
      i++;
      out += PLACEHOLDER;
      continue;
    }

    // :: cast operator — consume both colons so the type name that follows is
    // not mistaken for a named placeholder.
    if (ch === ":" && next === ":") {
      out += "::";
      i += 2;
      continue;
    }

    // :name / :1 named placeholder
    if (ch === ":" && (isIdentChar(next) || isDigit(next))) {
      i++;
      while (isIdentChar(sql[i])) i++;
      out += PLACEHOLDER;
      continue;
    }

    // numeric literal — only when not part of an identifier
    if ((isDigit(ch) || (ch === "." && isDigit(next))) && !isIdentChar(before)) {
      // 0x / 0b hex and binary literals
      if (ch === "0" && (next === "x" || next === "X" || next === "b" || next === "B")) {
        i += 2;
        while (isIdentChar(sql[i])) i++;
      } else {
        while (isDigit(sql[i])) i++;
        if (sql[i] === ".") {
          i++;
          while (isDigit(sql[i])) i++;
        }
        if (sql[i] === "e" || sql[i] === "E") {
          const save = i;
          i++;
          if (sql[i] === "+" || sql[i] === "-") i++;
          if (isDigit(sql[i])) {
            while (isDigit(sql[i])) i++;
          } else {
            i = save;
          }
        }
      }
      out += PLACEHOLDER;
      continue;
    }

    out += ch;
    i++;
  }

  return (
    out
      .replace(/\s+/g, " ")
      // `IN (?, ?, ?)` and `VALUES (?, ?)` vary in length between calls that are
      // otherwise identical — collapse runs of placeholders to a single one.
      .replace(/\?(?:\s*,\s*\?)+/g, PLACEHOLDER)
      .trim()
  );
}

export type StatementKind =
  | "select"
  | "insert"
  | "update"
  | "delete"
  /** Transaction control and session setup — never application queries. */
  | "control"
  | "other";

/**
 * Statements that manage a transaction or session rather than move data.
 *
 * These have to be excluded by default. An ORM opens a transaction per write,
 * so a handler doing three saves issues three identical `START TRANSACTION`
 * and three identical `COMMIT` statements — which look exactly like duplicated
 * work while being nothing of the sort. Reporting them buries the real
 * findings under noise.
 */
const CONTROL_STATEMENT =
  /^(begin|start\s+transaction|commit|rollback|savepoint|release\s+savepoint|set\s|reset\s|discard\s|listen\s|unlisten\s|deallocate\b|prepare\s+transaction)/i;

/** Best-effort classification of a statement, used for filtering and display. */
export function statementKind(sql: string): StatementKind {
  // Skip leading comments and CTEs so `WITH x AS (...) SELECT` reads as a select.
  const head = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trimStart()
    .slice(0, 4096)
    .toLowerCase();

  if (head.startsWith("with")) {
    const m = /\b(select|insert|update|delete)\b/.exec(head);
    if (m) return m[1] as StatementKind;
    return "other";
  }
  if (head.startsWith("select")) return "select";
  if (head.startsWith("insert")) return "insert";
  if (head.startsWith("update")) return "update";
  if (head.startsWith("delete")) return "delete";
  if (CONTROL_STATEMENT.test(head)) return "control";
  return "other";
}

/** Shortens a query for single-line display without cutting mid-word. */
export function truncateSql(sql: string, max = 100): string {
  if (sql.length <= max) return sql;
  return `${sql.slice(0, max - 1).trimEnd()}…`;
}
