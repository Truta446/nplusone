import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFinding, formatSummary } from "../src/report.js";
import type { Finding, ScopeSummary } from "../src/types.js";

/**
 * report.ts — colour-output tests
 *
 * The color helpers now read `NO_COLOR`, `TERM`, and `isTTY` on every call,
 * so we can exercise both the coloured and plain paths by mutating env and
 * stubbing `process.stderr.isTTY`.
 *
 * IMPORTANT: tests must NOT depend on order — each one restores its stubs
 * and env vars in a `finally` block.
 */

// ── helpers ──────────────────────────────────────────────────────────

function makeFinding(
  overrides: Partial<Finding> = {},
): Finding {
  return {
    type: "n_plus_one",
    count: 10,
    sample: "SELECT * FROM items WHERE order_id = $1",
    normalized: "SELECT * FROM items WHERE order_id = ?",
    kind: "select",
    callsite: { file: "app.ts", line: 42, column: 5, function: "getItems" },
    builtAt: undefined,
    parent: undefined,
    scope: "GET /items",
    totalDurationMs: 250,
    breakdown: undefined,
    values: undefined,
    ...overrides,
  };
}

function makeSummary(
  findings: Finding[] = [makeFinding()],
): ScopeSummary {
  return {
    name: "GET /items",
    inferred: false,
    findings,
    queryCount: 11,
    durationMs: 300,
    queries: [],
  };
}

/**
 * Run a test body with NO_COLOR set, then clear it.
 * We can't use beforeEach/afterEach because the tests must be order-independent.
 */
function withNoColor(fn: () => void): void {
  const original = process.env["NO_COLOR"];
  try {
    process.env["NO_COLOR"] = "1";
    fn();
  } finally {
    if (original === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = original;
    }
  }
}

/**
 * Run a test body with TERM=dumb, then restore.
 */
function withDumbTerm(fn: () => void): void {
  const original = process.env["TERM"];
  try {
    process.env["TERM"] = "dumb";
    fn();
  } finally {
    if (original === undefined) {
      delete process.env["TERM"];
    } else {
      process.env["TERM"] = original;
    }
  }
}

/**
 * Run a test body with isTTY=false, then restore.
 */
function withNoTTY(fn: () => void): void {
  const original = process.stderr.isTTY;
  try {
    process.stderr.isTTY = false;
    fn();
  } finally {
    process.stderr.isTTY = original;
  }
}

// ── tests ────────────────────────────────────────────────────────────

test("NO_COLOR → no escape codes", () => {
  withNoColor(() => {
    const out = formatSummary(makeSummary());
    // Escape codes start with \u001b (0x1b)
    assert.ok(
      !/\u001b\[\d+m/.test(out),
      "output must not contain ANSI escape codes when NO_COLOR is set",
    );
  });
});

test("TERM=dumb → no escape codes", () => {
  withDumbTerm(() => {
    const out = formatSummary(makeSummary());
    assert.ok(
      !/\u001b\[\d+m/.test(out),
      "output must not contain ANSI escape codes when TERM=dumb",
    );
  });
});

test("Not a TTY → no escape codes (CI case)", () => {
  withNoTTY(() => {
    const out = formatSummary(makeSummary());
    assert.ok(
      !/\u001b\[\d+m/.test(out),
      "output must not contain ANSI escape codes when stderr is not a TTY",
    );
  });
});

test("TTY and no NO_COLOR → codes present", () => {
  // Ensure NO_COLOR is unset and TERM is not dumb, and force isTTY=true
  // (the test runner may not have a TTY).
  const origNoColor = process.env["NO_COLOR"];
  const origTerm = process.env["TERM"];
  const origTTY = process.stderr.isTTY;
  try {
    delete process.env["NO_COLOR"];
    if (process.env["TERM"] === "dumb") {
      process.env["TERM"] = "xterm-256color";
    }
    process.stderr.isTTY = true;
    const out = formatSummary(makeSummary());
    assert.ok(
      /\u001b\[\d+m/.test(out),
      "output must contain ANSI escape codes in a TTY with NO_COLOR unset",
    );
  } finally {
    if (origNoColor === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = origNoColor;
    }
    if (origTerm === undefined) {
      delete process.env["TERM"];
    } else {
      process.env["TERM"] = origTerm;
    }
    process.stderr.isTTY = origTTY;
  }
});

test("formatFinding with both finding types, with and without NO_COLOR", () => {
  // With colors (force isTTY=true since the test runner may not have a TTY)
  const origTTY = process.stderr.isTTY;
  const origNoColor = process.env["NO_COLOR"];
  const origTerm = process.env["TERM"];
  try {
    process.stderr.isTTY = true;
    delete process.env["NO_COLOR"];
    if (process.env["TERM"] === "dumb") {
      process.env["TERM"] = "xterm-256color";
    }

    const nPlusOneFinding = makeFinding({ type: "n_plus_one" });
    const dupFinding = makeFinding({
      type: "duplicate",
      count: 3,
      sample: "SELECT 1",
      normalized: "SELECT 1",
    });

    const n1Out = formatFinding(nPlusOneFinding);
    const dupOut = formatFinding(dupFinding);

    // Both should contain escape codes (assuming TTY)
    assert.ok(/\u001b\[\d+m/.test(n1Out), "n_plus_one finding should have codes");
    assert.ok(/\u001b\[\d+m/.test(dupOut), "duplicate finding should have codes");
  } finally {
    process.stderr.isTTY = origTTY;
    if (origNoColor === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = origNoColor;
    }
    if (origTerm === undefined) {
      delete process.env["TERM"];
    } else {
      process.env["TERM"] = origTerm;
    }
  }

  // Now check without colors
  withNoColor(() => {
    const n1Plain = formatFinding(makeFinding({ type: "n_plus_one" }));
    const dupPlain = formatFinding(makeFinding({
      type: "duplicate",
      count: 3,
      sample: "SELECT 1",
      normalized: "SELECT 1",
    }));
    assert.ok(
      !/\u001b\[\d+m/.test(n1Plain),
      "n_plus_one must be plain text without color",
    );
    assert.ok(
      !/\u001b\[\d+m/.test(dupPlain),
      "duplicate must be plain text without color",
    );
  });
});

test("formatSummary with one finding and with several", () => {
  const multiSummary = makeSummary([
    makeFinding({ type: "n_plus_one" }),
    makeFinding({
      type: "duplicate",
      count: 5,
      sample: "SELECT 1",
      normalized: "SELECT 1",
    }),
  ]);

  const out = formatSummary(multiSummary);
  // Should contain both "N+1 query" and "Duplicate query" headlines
  assert.ok(out.includes("N+1 query"), "should mention N+1 query");
  assert.ok(out.includes("Duplicate query"), "should mention Duplicate query");

  withNoColor(() => {
    const plain = formatSummary(multiSummary);
    assert.ok(
      !/\u001b\[\d+m/.test(plain),
      "multi-finding summary must be plain without color",
    );
  });
});