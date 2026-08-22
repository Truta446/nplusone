import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { configure, formatFinding, record, resetConfig, runInScope } from "../src/index.js";
import type { Finding } from "../src/index.js";

/**
 * Parent detection — the "1" in N+1.
 *
 * Every test here is really the same test twice over: does it find the parent
 * when there is one, and does it stay quiet when the candidate is anything
 * less than convincing. The second half is the one that matters. A wrong
 * parent points at two unrelated tables and says "join these".
 */

beforeEach(() => {
  resetConfig();
  configure({ threshold: 5, mode: "silent", enabled: true, captureStack: false });
});

async function findingsOf(fn: () => void): Promise<readonly Finding[]> {
  let findings: readonly Finding[] = [];
  await runInScope("GET /orders", (scope) => {
    fn();
    findings = scope.findings;
  });
  return findings;
}

function nPlusOne(findings: readonly Finding[], sql: string): Finding {
  const found = findings.find(
    (f) => f.type === "n_plus_one" && f.normalized.includes(sql),
  );
  assert.ok(found, `expected an N+1 for ${sql}`);
  return found;
}

test("names the single read that ran just before the loop", async () => {
  const findings = await findingsOf(() => {
    record({ sql: "SELECT * FROM orders WHERE user_id = 7" });
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });

  const finding = nPlusOne(findings, "items");
  assert.equal(finding.parent?.normalized, "SELECT * FROM orders WHERE user_id = ?");
  assert.equal(finding.parent?.kind, "select");
});

test("says nothing when the loop is the first thing in the scope", async () => {
  // The ids came from a request body, a cache, another service — the parent is
  // not in this scope and guessing at one would be inventing it.
  const findings = await findingsOf(() => {
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });

  assert.equal(nPlusOne(findings, "items").parent, undefined);
});

test("says nothing when the preceding statement ran more than once", async () => {
  const findings = await findingsOf(() => {
    record({ sql: "SELECT * FROM orders WHERE user_id = 7" });
    record({ sql: "SELECT * FROM orders WHERE user_id = 8" });
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });

  assert.equal(nPlusOne(findings, "items").parent, undefined);
});

test("says nothing when the preceding statement is a write", async () => {
  const findings = await findingsOf(() => {
    record({ sql: "INSERT INTO audit (action) VALUES ('read')" });
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });

  assert.equal(nPlusOne(findings, "items").parent, undefined);
});

test("two interleaved loops: the first gets a parent, the second stays quiet", async () => {
  const findings = await findingsOf(() => {
    record({ sql: "SELECT * FROM users WHERE id = 1" });
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM orders WHERE user_id = ${id}` });
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });

  assert.equal(
    nPlusOne(findings, "orders").parent?.normalized,
    "SELECT * FROM users WHERE id = ?",
  );
  // What precedes the items loop is the orders loop, which repeats — so it is
  // another loop, not the "1".
  assert.equal(nPlusOne(findings, "items").parent, undefined);
});

test("steps over transaction control between the parent and the loop", async () => {
  configure({ includeTransactionControl: true });
  const findings = await findingsOf(() => {
    record({ sql: "SELECT * FROM orders WHERE user_id = 7" });
    record({ sql: "BEGIN" });
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });

  assert.equal(
    nPlusOne(findings, "items").parent?.normalized,
    "SELECT * FROM orders WHERE user_id = ?",
  );
});

test("never attaches a parent to a duplicate finding", async () => {
  configure({ duplicateThreshold: 2 });
  const findings = await findingsOf(() => {
    record({ sql: "SELECT * FROM orders WHERE user_id = 7" });
    record({ sql: "SELECT * FROM settings WHERE id = 1" });
    record({ sql: "SELECT * FROM settings WHERE id = 1" });
  });

  const duplicate = findings.find((f) => f.type === "duplicate");
  assert.ok(duplicate);
  assert.equal(duplicate.parent, undefined);
});

test("detectParent: false turns it off", async () => {
  configure({ detectParent: false });
  const findings = await findingsOf(() => {
    record({ sql: "SELECT * FROM orders WHERE user_id = 7" });
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });

  assert.equal(nPlusOne(findings, "items").parent, undefined);
});

test("the report marks it as a guess", async () => {
  const findings = await findingsOf(() => {
    record({ sql: "SELECT * FROM orders WHERE user_id = 7" });
    for (let id = 0; id < 7; id++) {
      record({ sql: `SELECT * FROM items WHERE order_id = ${id}` });
    }
  });

  const rendered = formatFinding(nPlusOne(findings, "items"));
  assert.match(rendered, /after 1× SELECT \* FROM orders WHERE user_id = \?/);
  assert.match(rendered, /a guess/);
});
