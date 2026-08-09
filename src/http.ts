/**
 * Request scoping.
 *
 * One scope per request is the unit that matters: fifty identical queries
 * across a day are normal, fifty while rendering one page are a bug.
 */

import { Scope, runWithScope, runInScope } from "./scope.js";

interface MinimalRequest {
  method?: string | undefined;
  url?: string | undefined;
  originalUrl?: string | undefined;
  route?: { path?: string } | undefined;
}

interface MinimalResponse {
  on?: (event: string, listener: () => void) => unknown;
}

type NextFunction = (error?: unknown) => void;

function defaultName(req: MinimalRequest): string {
  const method = req.method ?? "REQUEST";
  // Prefer the route pattern (`/orders/:id`) over the concrete URL so findings
  // from different ids group under one name in aggregate reporting.
  const path =
    req.route?.path ??
    (req.originalUrl ?? req.url ?? "/").split("?")[0] ??
    "/";
  return `${method} ${path}`;
}

export interface MiddlewareOptions {
  /** Overrides the scope name shown in reports. */
  name?: (req: MinimalRequest) => string;
}

/**
 * Express / Connect middleware. Install it before your routes.
 *
 * ```ts
 * app.use(nplusoneMiddleware());
 * ```
 *
 * The scope closes when the response finishes, so queries issued in
 * `res.on("finish")` handlers and trailing awaits are still attributed.
 */
export function nplusoneMiddleware(options: MiddlewareOptions = {}) {
  const nameOf = options.name ?? defaultName;

  return function nplusone(
    req: MinimalRequest,
    res: MinimalResponse,
    next: NextFunction,
  ): void {
    const scope = new Scope(nameOf(req));

    runWithScope(scope, () => {
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        scope.close();
      };

      if (typeof res.on === "function") {
        res.on("finish", close);
        res.on("close", close);
      } else {
        // No lifecycle events to hook — close once the handler chain returns.
        queueMicrotask(close);
      }

      next();
    });
  };
}

/**
 * Wraps a fetch-style handler (Hono, Next.js route handlers, Deno, Bun,
 * Cloudflare Workers).
 *
 * ```ts
 * export const GET = withRequestScope(async (req) => { ... });
 * ```
 */
export function withRequestScope<Req extends { method: string; url: string }, Res>(
  handler: (request: Req) => Res | Promise<Res>,
): (request: Req) => Promise<Res> {
  return (request: Req) => {
    let path = request.url;
    try {
      path = new URL(request.url).pathname;
    } catch {
      // Relative or malformed URL — keep it as given.
    }
    return runInScope(`${request.method} ${path}`, () => handler(request));
  };
}
