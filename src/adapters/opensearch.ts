/**
 * Adapter for `@opensearch-project/opensearch` (and Elasticsearch's client,
 * which shares this transport design).
 *
 * The N+1 here looks like this, and it is a favourite:
 *
 * ```ts
 * const hits = await client.search({ index: "orders", body: query });
 * for (const hit of hits.body.hits.hits) {
 *   await client.get({ index: "customers", id: hit._source.customer_id });
 * }
 * ```
 *
 * `_mget` and `_msearch` exist for exactly this, and both are one request.
 *
 * The client builds its API methods as own properties on each instance, so
 * there are dozens of entry points and no prototype holding them. There is,
 * however, exactly one funnel underneath: `Transport.prototype.request`. Every
 * `search`, `get`, `index` and `bulk` ends there, which makes it the one patch
 * that cannot miss a call — and it means a batched request arrives as a single
 * observation for free, because that is genuinely what it is on the wire.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import type { StatementKind } from "../normalize.js";
import {
  combineRestores,
  disabled,
  observe,
  patchMethod,
  unpatchMethod,
  type AnyFn,
} from "./shared.js";

interface TransportParams {
  method?: unknown;
  path?: unknown;
  body?: unknown;
  querystring?: unknown;
}

interface ClientLike {
  transport?: object;
}

/** Paths whose read-ness the HTTP method alone would get wrong. */
const READ_ENDPOINTS = new Set([
  "_search",
  "_msearch",
  "_mget",
  "_count",
  "_explain",
  "_field_caps",
  "_search_shards",
  "_validate",
  "_termvectors",
  "_mtermvectors",
  "_rank_eval",
]);

function looksLikeId(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return true;
  }
  // A long unbroken hex token. Deliberately strict: an index name like
  // `logs-2026.08.01` also has digits in it, and collapsing those would hide a
  // loop that queries one index per day.
  return /^[0-9a-f]{16,}$/i.test(segment);
}

/**
 * Endpoints whose next segment is a document id rather than more API.
 *
 * A whitelist rather than "anything after a segment starting with `_`", because
 * that broader rule turns `/_cluster/health` into `/_cluster/*` and
 * `/_cat/indices` into `/_cat/*` — collapsing distinct endpoints into one, and
 * inventing a varying value where there is none.
 */
const ID_BEARING = new Set([
  "_doc",
  "_source",
  "_create",
  "_update",
  "_explain",
  "_termvectors",
  "_alias",
  "_mapping",
]);

/**
 * A request path with document ids replaced, so a loop groups into one finding.
 *
 * `/products/_doc/1` and `/products/_doc/2` have to become the same statement
 * or nothing ever groups. The rule is positional and therefore reliable: the
 * segment **after** a document endpoint is an id, so `/products/_doc/abc`
 * becomes `/products/_doc/*`. Anything else is only replaced when it plainly
 * looks like an id on its own.
 *
 * Index names are deliberately left alone. That means a time-series layout —
 * `logs-2026.08.01`, `logs-2026.08.02` — does not group across days, and that
 * is the right way round: those really are different indices, and collapsing
 * them would hide a loop that queries one index per day.
 */
export function normalizeSearchPath(path: string): string {
  const segments = path.split("/");
  const out: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "" || segment.startsWith("_")) {
      out.push(segment);
      continue;
    }
    const previous = segments[i - 1];
    if (previous !== undefined && ID_BEARING.has(previous)) {
      out.push("*");
      continue;
    }
    out.push(looksLikeId(segment) ? "*" : segment);
  }

  return out.join("/");
}

function endpointOf(path: string): string | undefined {
  for (const segment of path.split("/")) {
    if (segment.startsWith("_")) return segment;
  }
  return undefined;
}

/**
 * Best-effort classification. The HTTP method carries most of it; the endpoint
 * settles the cases where it does not, because a search is a `POST`.
 */
function kindOf(method: string, path: string): StatementKind {
  const endpoint = endpointOf(path);
  if (endpoint !== undefined && READ_ENDPOINTS.has(endpoint)) return "select";
  if (endpoint === "_update" || endpoint === "_update_by_query") return "update";
  if (endpoint === "_delete_by_query") return "delete";
  if (endpoint === "_bulk") return "other";

  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "select";
    case "PUT":
    case "POST":
      return "insert";
    case "DELETE":
      return "delete";
    default:
      return "other";
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

/**
 * What varies between iterations, so the detector can tell an N+1 from a
 * statement that merely ran twice.
 *
 * The body matters and is the reason this is not just the path: a loop issuing
 * `POST /orders/_search` with a different query each time has an identical path
 * on every iteration, and without the body there would be nothing to vary. That
 * is the single most common shape of this bug against a search engine, so
 * missing it would leave the adapter looking like it worked.
 *
 * The path matters for the same reason in reverse. `GET /customers/_doc/7` is
 * normalized to `/customers/_doc/*` so that a loop *groups* — but that erases
 * the only thing that differed between iterations, and a fetch-by-id loop
 * carries no body at all. The raw path goes back in as a value, so what
 * normalization took out for grouping is still there for discriminating.
 *
 * Returns undefined rather than an empty array when there is nothing — an empty
 * array is a discriminator that never changes, which silently switches
 * detection off for the statement.
 */
function discriminator(params: TransportParams, normalizedPath: string): readonly unknown[] | undefined {
  const values: unknown[] = [];
  if (typeof params.path === "string" && params.path !== normalizedPath) {
    values.push(params.path);
  }
  if (!isEmpty(params.querystring)) values.push(params.querystring);
  if (!isEmpty(params.body)) values.push(params.body);
  return values.length === 0 ? undefined : values;
}

function wrapRequest(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const params = args[0] as TransportParams | undefined;
    const path = params?.path;
    if (typeof path !== "string") return original.apply(this, args);

    const method = typeof params?.method === "string" ? params.method : "GET";
    const normalized = normalizeSearchPath(path);

    const statement = `${method.toUpperCase()} ${normalized}`;
    return observe(
      {
        sql: statement,
        // Already normalized: SQL normalization reads the `/*` of a wildcarded
        // path as the start of a block comment and eats the rest of the line.
        normalized: statement,
        params: discriminator(params as TransportParams, normalized),
        kind: kindOf(method, path),
      },
      () => original.apply(this, args),
    );
  };
}

/**
 * Instruments an OpenSearch (or Elasticsearch) client.
 *
 * ```ts
 * import { Client } from "@opensearch-project/opensearch";
 * import { instrumentOpenSearch } from "nplusone/opensearch";
 *
 * const client = new Client({ node: process.env.OPENSEARCH_URL });
 * instrumentOpenSearch(client);
 * ```
 *
 * This patches the transport **prototype**, which every client of that class
 * shares — so one call covers every client you build, and calling it a second
 * time does not double count. `restore()` puts it back for all of them.
 *
 * `_msearch`, `_mget` and `_bulk` are each one request on the wire and are
 * recorded as one query, which is the point: they are the fix, and reporting
 * them as repeated work would argue against the thing worth doing.
 */
export function instrumentOpenSearch(client: ClientLike): () => void {
  const transport = client?.transport;
  if (typeof transport !== "object" || transport === null) {
    throw new TypeError(
      "instrumentOpenSearch() expected an OpenSearch client (with a transport).",
    );
  }

  const prototype = Object.getPrototypeOf(transport) as Record<string, any> | null;
  // A transport built without a class — a hand-rolled fake, typically — has its
  // `request` as an own property, so patch the object itself.
  const target =
    prototype !== null && typeof prototype["request"] === "function"
      ? prototype
      : (transport as Record<string, any>);

  if (typeof target["request"] !== "function") {
    throw new TypeError(
      "instrumentOpenSearch() expected the client's transport to have a request() method.",
    );
  }

  const restores: (() => void)[] = [];
  if (patchMethod(target, "request", wrapRequest)) {
    restores.push(() => {
      unpatchMethod(target, "request");
    });
  }
  return combineRestores(restores);
}
