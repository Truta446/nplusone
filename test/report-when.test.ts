import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, record, runInScope } from "../src/index.js";
import type { ScopeSummary } from "../src/index.js";

/**
 * reportWhen — when the built-in reporter prints.
 *
 * The interesting behaviour is not that immediate output happens, it is what it
 * says: a count that is still rising has to read as a lower bound, and a
 * finding printed twice has to read as one problem seen twice.
 */

/** Runs `fn` with stderr captured, restoring it however `fn` ends. */
async function capturingStderr(fn: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return written.join("");
}

/** Seven repetitions of one shape, which is enough to cross a threshold of 5. */
async function loop(name = "GET /orders"): Promise<void> {
  await runInScope(name, () => {
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });
}

beforeEach(() => {
  resetConfig();
  configure({ threshold: 5, mode: "warn", enabled: true, captureStack: false });
});

test("prints only at scope close by default", async () => {
  const output = await capturingStderr(loop);

  assert.match(output, /1 finding in GET \/orders/);
  assert.match(output, /7×/, "the count is final by the time it prints");
  assert.doesNotMatch(output, /live in/);
  assert.doesNotMatch(output, /≥/);
});

test("immediate mode prints once, at detection, with the count as a lower bound", async () => {
  configure({ reportWhen: "immediately" });
  const output = await capturingStderr(loop);

  assert.match(output, /nplusone live in GET \/orders/);
  // Five is where the threshold was crossed; the loop ran seven times. The
  // report has to be honest that it does not know that yet.
  assert.match(output, /≥5×/);
  assert.match(output, /still counting/);

  // And not again at close, under a different count, as if it were a second
  // problem.
  assert.doesNotMatch(output, /finding in GET \/orders/);
  assert.equal(output.match(/N\+1 query/g)?.length, 1);
});

test("both mode prints at detection and again with the total", async () => {
  configure({ reportWhen: "both" });
  const output = await capturingStderr(loop);

  assert.match(output, /≥5×/);
  assert.match(output, /1 finding in GET \/orders/);
  assert.match(output, /7×/);
  assert.equal(output.match(/N\+1 query/g)?.length, 2);
});

test("immediate mode still reports a budget finding at close", async () => {
  // The budget finding is only born when the scope closes, so it is the case
  // that proves the close-time report is suppressed per finding rather than
  // switched off wholesale.
  configure({ reportWhen: "immediately", maxQueries: 3 });
  const output = await capturingStderr(loop);

  assert.match(output, /live in GET \/orders/, "the N+1 arrived immediately");
  assert.match(output, /Query budget/);
  assert.match(output, /1 finding in GET \/orders/, "and only the budget one at close");
  assert.equal(output.match(/N\+1 query/g)?.length, 1);
});

test("silent mode prints nothing, whatever reportWhen says", async () => {
  configure({ reportWhen: "both", mode: "silent" });
  assert.equal(await capturingStderr(loop), "");
});

test("a custom reporter is never printed behind", async () => {
  const summaries: ScopeSummary[] = [];
  configure({ reportWhen: "immediately", reporter: (s) => summaries.push(s) });

  const output = await capturingStderr(loop);

  assert.equal(output, "", "the reporter owns the output");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.findings.length, 1, "and still sees the finding");
});

test("throw mode prints the finding before it raises", async () => {
  configure({ reportWhen: "immediately", mode: "throw" });

  const output = await capturingStderr(async () => {
    await assert.rejects(loop, /N\+1/);
  });

  assert.match(output, /live in GET \/orders/);
});
