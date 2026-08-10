/**
 * nplusone — catch N+1 queries in Node.js at runtime.
 *
 * The detector watches the database driver rather than any particular ORM, so
 * it works the same whether you use Prisma, Drizzle, Knex, TypeORM or hand
 * written SQL. Queries are counted inside a scope (a request, a job, a test);
 * when one statement shape repeats from one line of code with different
 * values, that is an N+1 and it gets reported with the file and line that
 * caused it.
 *
 * @example Development
 * ```ts
 * import pg from "pg";
 * import { configure } from "nplusone";
 * import { instrumentPg } from "nplusone/pg";
 * import { nplusoneMiddleware } from "nplusone/http";
 *
 * configure({ threshold: 5 });
 * instrumentPg(pg);
 * app.use(nplusoneMiddleware());
 * ```
 *
 * @example CI
 * ```ts
 * import { expectNoNPlusOne } from "nplusone/test";
 *
 * await expectNoNPlusOne(() => loadOrdersPage(userId));
 * ```
 */

export { configure, getOptions, resetConfig } from "./config.js";

export {
  Scope,
  record,
  runInScope,
  runInScopeSync,
  runWithScope,
  getCurrentScope,
  flushAutoScope,
  resetScopeWarning,
  type RecordInput,
} from "./scope.js";

export { NPlusOneError } from "./error.js";

export { formatFinding, formatSummary, defaultReporter } from "./report.js";

export { normalizeSql, statementKind, truncateSql } from "./normalize.js";

export { captureCallSite, formatCallSite, callSiteKey } from "./callsite.js";

export type {
  CallSite,
  Finding,
  FindingType,
  Mode,
  Options,
  RecordedQuery,
  ResolvedOptions,
  ScopeSummary,
  StatementKind,
} from "./types.js";
