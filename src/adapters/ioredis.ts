/**
 * Adapter for `ioredis`.
 *
 * An N+1 is not a SQL problem. It is one round trip per item in a loop, and a
 * cache is where that shape hides best — each call is fast enough that nobody
 * notices until the list gets long:
 *
 * ```ts
 * for (const id of productIds) await redis.get(`product:${id}`);   // 200 trips
 * ```
 *
 * `MGET` exists, and so does pipelining. The loop above is the bug this library
 * was built to find, against a different driver.
 *
 * Every single command funnels through `Redis.prototype.sendCommand`, so that
 * is the one patch that covers all of them. A pipeline needs care — see
 * {@link PIPELINED}.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver boundary */

import type { StatementKind } from "../normalize.js";
import {
  combineRestores,
  disabled,
  observe,
  observeBatch,
  patchMethod,
  unpatchMethod,
  type AnyFn,
  type Observation,
} from "./shared.js";

interface RedisCommand {
  name?: unknown;
  args?: unknown;
}

interface RedisModule {
  prototype?: Record<string, any>;
}

/**
 * Commands that are bookkeeping or long-lived, never an application read.
 *
 * `SELECT` is Redis's "choose a database", not a query. A blocking pop parks
 * for seconds by design, and reporting it as slow repeated work would be
 * exactly backwards. This is the same reasoning that keeps `BEGIN` and `COMMIT`
 * out of a SQL scope by default.
 */
const IGNORED = new Set([
  "auth",
  "select",
  "ping",
  "echo",
  "info",
  "quit",
  "subscribe",
  "unsubscribe",
  "psubscribe",
  "punsubscribe",
  "ssubscribe",
  "sunsubscribe",
  "client",
  "cluster",
  "command",
  "config",
  "hello",
  "readonly",
  "readwrite",
  "wait",
  // Blocking by design.
  "blpop",
  "brpop",
  "blmove",
  "blmpop",
  "brpoplpush",
  "bzpopmin",
  "bzpopmax",
  "bzmpop",
  "xread",
  "xreadgroup",
]);

/** Commands whose repetition is worth a `select`-shaped finding. */
const READS = new Set([
  "get",
  "mget",
  "getex",
  "getrange",
  "strlen",
  "exists",
  "ttl",
  "pttl",
  "type",
  "hget",
  "hmget",
  "hgetall",
  "hkeys",
  "hvals",
  "hlen",
  "hexists",
  "hrandfield",
  "lrange",
  "lindex",
  "llen",
  "lpos",
  "smembers",
  "sismember",
  "smismember",
  "scard",
  "srandmember",
  "zrange",
  "zrangebyscore",
  "zrevrange",
  "zscore",
  "zmscore",
  "zcard",
  "zcount",
  "zrank",
  "getbit",
  "bitcount",
  "json.get",
  "json.mget",
]);

const WRITES: Record<string, StatementKind> = {
  set: "insert",
  setex: "insert",
  setnx: "insert",
  mset: "insert",
  msetnx: "insert",
  append: "update",
  getset: "update",
  incr: "update",
  incrby: "update",
  incrbyfloat: "update",
  decr: "update",
  decrby: "update",
  hset: "insert",
  hmset: "insert",
  hsetnx: "insert",
  hincrby: "update",
  hincrbyfloat: "update",
  lpush: "insert",
  rpush: "insert",
  lpop: "delete",
  rpop: "delete",
  lset: "update",
  sadd: "insert",
  srem: "delete",
  zadd: "insert",
  zrem: "delete",
  zincrby: "update",
  setbit: "update",
  expire: "update",
  pexpire: "update",
  persist: "update",
  rename: "update",
  del: "delete",
  unlink: "delete",
  hdel: "delete",
  flushdb: "delete",
  flushall: "delete",
};

function kindOf(command: string): StatementKind {
  if (READS.has(command)) return "select";
  return WRITES[command] ?? "other";
}

/**
 * A key with its variable parts replaced, so `product:1` and `product:2` group.
 *
 * **This is the design decision the whole adapter turns on.** Report the key
 * verbatim and nothing ever groups, because every iteration is a different
 * statement. Report the command alone and every read in the request collapses
 * into one finding that says nothing about which one.
 *
 * The rule: `:` is the delimiter — it is what redis.io's own guidance
 * recommends and what every convention in the wild uses — and a segment is
 * replaced when it is all digits, or a long hex or UUID-shaped string. So
 * `user:42:sessions` becomes `user:*:sessions` and the shape survives while the
 * id goes.
 *
 * **Its limit, stated rather than papered over:** a key that does not use `:`
 * is left alone, so `abc1` and `abc2` will not group and the loop over them
 * goes unreported. Guessing at a segmenting rule for arbitrary key names would
 * be inventing a convention on someone else's behalf, and being confidently
 * wrong about where an N+1 is costs more than staying quiet.
 *
 * The *values* still discriminate: the raw arguments go into `params`, so the
 * detector sees them vary. Normalization only has to make the shape group.
 */
export function normalizeRedisKey(key: string): string {
  if (!key.includes(":")) return key;
  return key
    .split(":")
    .map((segment) => {
      if (segment.length === 0) return segment;
      if (/^\d+$/.test(segment)) return "*";
      if (/^[0-9a-f-]{8,}$/i.test(segment) && /\d/.test(segment)) return "*";
      return segment;
    })
    .join(":");
}

function statementOf(command: string, args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first !== "string") return command.toUpperCase();
  return `${command.toUpperCase()} ${normalizeRedisKey(first)}`;
}

function argsOf(command: RedisCommand): readonly unknown[] {
  return Array.isArray(command.args) ? command.args : [];
}

/** Nothing to observe, or a command that is bookkeeping rather than a query. */
function observationOf(command: RedisCommand): Observation | undefined {
  const name = typeof command.name === "string" ? command.name.toLowerCase() : undefined;
  if (name === undefined || IGNORED.has(name)) return undefined;

  const args = argsOf(command);
  const statement = statementOf(name, args);
  return {
    sql: statement,
    // Already normalized: SQL normalization would read `:sessions` in a key as
    // a named bind and rewrite it to `?`.
    normalized: statement,
    // What varies between iterations of an N+1 loop is the key, so the raw
    // arguments are the discriminator.
    params: args.length === 0 ? undefined : args,
    kind: kindOf(name),
  };
}

/**
 * Marks a command as already accounted for by a pipeline flush.
 *
 * `Pipeline.exec()` calls `redis.sendCommand()` once per queued command, so
 * patching only `sendCommand` would record a pipeline of fifty `GET`s as fifty
 * round trips and report it as an N+1 — telling people to stop doing the exact
 * thing this library wants them to do. The queue is recorded as one batch at
 * `exec()`, each command is marked, and `sendCommand` leaves marked ones alone.
 *
 * Marking the command object rather than setting a flag is deliberate: a flag
 * would have to be unset again, and `exec()` writes asynchronously.
 */
const PIPELINED = Symbol.for("nplusone.ioredis.pipelined");

function wrapSendCommand(original: AnyFn): AnyFn {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const command = args[0] as (RedisCommand & { [PIPELINED]?: boolean }) | undefined;
    if (command === undefined || command[PIPELINED] === true) {
      return original.apply(this, args);
    }

    const observation = observationOf(command);
    if (observation === undefined) return original.apply(this, args);

    return observe(observation, () => original.apply(this, args));
  };
}

function wrapPipelineExec(original: AnyFn): AnyFn {
  return function patched(this: any, ...args: unknown[]): unknown {
    if (disabled()) return original.apply(this, args);

    const queue = this?._queue;
    if (!Array.isArray(queue) || queue.length === 0) {
      return original.apply(this, args);
    }

    const observations: Observation[] = [];
    for (const command of queue as (RedisCommand & { [PIPELINED]?: boolean })[]) {
      command[PIPELINED] = true;
      const observation = observationOf(command);
      if (observation !== undefined) observations.push(observation);
    }

    // One round trip. `observeBatch` divides it evenly across the statements,
    // so the sum — which is what a finding reports — stays the measurement.
    return observeBatch(observations, () => original.apply(this, args));
  };
}

/**
 * Patches the `exec` of whatever prototype a pipeline came from.
 *
 * `ioredis` does not export `Pipeline`, and its prototype is only reachable
 * through an instance — so the first pipeline a client builds is used to reach
 * it, the same way the Oracle adapter reaches a connection's prototype.
 * `multi()` shares that prototype, so one adoption covers both.
 */
function adoptPipeline(pipeline: unknown, restores: (() => void)[]): void {
  if (typeof pipeline !== "object" || pipeline === null) return;
  const prototype = Object.getPrototypeOf(pipeline) as Record<string, any> | null;
  if (prototype === null) return;

  if (patchMethod(prototype, "exec", wrapPipelineExec)) {
    restores.push(() => {
      unpatchMethod(prototype, "exec");
    });
  }
}

function wrapBuilder(restores: (() => void)[]) {
  return (original: AnyFn): AnyFn =>
    function patched(this: unknown, ...args: unknown[]): unknown {
      const pipeline = original.apply(this, args);
      adoptPipeline(pipeline, restores);
      return pipeline;
    };
}

/**
 * Instruments `ioredis`.
 *
 * ```ts
 * import Redis from "ioredis";
 * import { instrumentIoredis } from "nplusone/ioredis";
 *
 * instrumentIoredis(Redis);
 * ```
 *
 * Call it once, before creating a client. Pipelines and `multi()` are recorded
 * as one batch rather than as N round trips, because batching is the fix and
 * reporting it as the bug would be worse than reporting nothing at all.
 *
 * `node-redis` (the `redis` package) has a different client API — commands are
 * methods on the client and there is no `sendCommand` funnel of this shape — so
 * it is not covered here and would need its own module.
 */
export function instrumentIoredis(redis: RedisModule): () => void {
  const prototype = redis?.prototype;
  if (prototype === undefined || typeof prototype["sendCommand"] !== "function") {
    throw new TypeError(
      "instrumentIoredis() expected the ioredis Redis class (with sendCommand on its prototype).",
    );
  }

  const restores: (() => void)[] = [];

  if (patchMethod(prototype, "sendCommand", wrapSendCommand)) {
    restores.push(() => {
      unpatchMethod(prototype, "sendCommand");
    });
  }

  for (const builder of ["pipeline", "multi"]) {
    if (patchMethod(prototype, builder, wrapBuilder(restores))) {
      restores.push(() => {
        unpatchMethod(prototype, builder);
      });
    }
  }

  return combineRestores(restores);
}
