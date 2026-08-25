import { test } from "node:test";
import assert from "node:assert/strict";
import { captureCallSite } from "../src/index.js";

/**
 * Runtime differences that attribution rests on.
 *
 * Attribution fails **quietly**: when a frame is missing or unparseable,
 * `captureCallSite` returns something plausible and the report names the wrong
 * line rather than erroring. A smoke test that only checks "a finding was
 * produced" passes on a runtime where the most useful half of the output is
 * wrong, so everything here asserts on the call site itself.
 */

/**
 * True on JavaScriptCore (Bun) rather than V8 (Node, Deno).
 *
 * JSC drops a frame in two cases V8 keeps: a call in **tail position**
 * (`return f()` — it implements ES6 proper tail calls), and a function small
 * enough to be **inlined**. Either way the frame does not exist to be read, so
 * attribution lands on the caller. There is nothing this library can do about
 * that; what it can do is measure it, say so, and not pretend otherwise.
 */
const isJavaScriptCore = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

const JSC_REASON =
  "JavaScriptCore eliminates the frame for an inlined or tail-position call, " +
  "so attribution lands on the caller. Measured on Bun 1.3 — see the README.";

test("a frame is parsed out of this runtime's stack format", () => {
  // The file and the line are what every runtime agrees on, and the parse
  // either works or the report is `<unknown call site>` for everything.
  const site = captureCallSite();

  assert.ok(site, "no frame was parsed — check FRAME_RE against this runtime");
  assert.match(site.file, /runtime\.test\./);
  assert.ok(site.line > 0);
  assert.ok(site.column > 0);
});

test("this library's own frames are never reported as application code", () => {
  // Deno source-maps `Error.stack`, so our frames arrive named `src/*.ts` while
  // the files on disk are `dist/*.js`. Before 0.9.0 that meant every finding on
  // Deno was blamed on `src/callsite.ts` — a report that was useless and gave
  // no sign of being useless.
  const site = captureCallSite();

  assert.ok(site);
  assert.doesNotMatch(site.file, /[/\\](src|dist)[/\\]callsite\.(ts|js)$/);
  assert.match(site.file, /runtime\.test\./);
});

test(
  "the enclosing function is named, whether or not the call is in tail position",
  { skip: isJavaScriptCore ? JSC_REASON : false },
  () => {
    function tailPosition(): ReturnType<typeof captureCallSite> {
      return captureCallSite();
    }
    function notTailPosition(): ReturnType<typeof captureCallSite> {
      const site = captureCallSite();
      return site;
    }

    assert.equal(tailPosition()?.function, "tailPosition");
    assert.equal(notTailPosition()?.function, "notTailPosition");
  },
);

test("a frame from a function that does real work is kept everywhere", () => {
  // The case that matters in practice: a handler or a repository method, not a
  // one-line pass-through. JSC inlines the latter and keeps the former, which
  // is why the README's caveat is about thin wrappers rather than about Bun.
  let sink = 0;
  function loadItems(): ReturnType<typeof captureCallSite> {
    for (let i = 0; i < 64; i++) sink += i % 3;
    const site = captureCallSite();
    for (let i = 0; i < 64; i++) sink += i % 5;
    return site;
  }

  const site = loadItems();
  assert.ok(sink > 0);
  assert.equal(site?.function, "loadItems");
});
