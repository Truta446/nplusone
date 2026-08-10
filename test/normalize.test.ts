import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSql, statementKind, truncateSql } from "../src/normalize.js";

test("collapses numeric literals so values do not split a shape", () => {
  assert.equal(
    normalizeSql("SELECT * FROM items WHERE order_id = 42"),
    normalizeSql("SELECT * FROM items WHERE order_id = 43"),
  );
  assert.equal(
    normalizeSql("SELECT * FROM items WHERE order_id = 42"),
    "SELECT * FROM items WHERE order_id = ?",
  );
});

test("does not mistake digits inside identifiers for literals", () => {
  assert.equal(normalizeSql("SELECT col2 FROM t1"), "SELECT col2 FROM t1");
  assert.equal(normalizeSql("SELECT a1.b2 FROM x9"), "SELECT a1.b2 FROM x9");
});

test("substitutes a literal that follows a keyword", () => {
  // The check has to look at the character immediately before the digit, not
  // the last non-space one — otherwise the `T` of `LIMIT` makes `42` look like
  // part of an identifier and pagination splits one shape into many.
  assert.equal(normalizeSql("SELECT * FROM t LIMIT 42"), "SELECT * FROM t LIMIT ?");
  assert.equal(
    normalizeSql("SELECT * FROM t LIMIT 10 OFFSET 20"),
    "SELECT * FROM t LIMIT ? OFFSET ?",
  );
  assert.equal(
    normalizeSql("SELECT * FROM t LIMIT 10 OFFSET 0"),
    normalizeSql("SELECT * FROM t LIMIT 10 OFFSET 40"),
  );
  assert.equal(normalizeSql("SELECT * FROM t WHERE a = -1"), "SELECT * FROM t WHERE a = -?");
});

test("replaces string literals, including escaped quotes", () => {
  assert.equal(normalizeSql("SELECT * FROM u WHERE n = 'ana'"), "SELECT * FROM u WHERE n = ?");
  assert.equal(
    normalizeSql("SELECT * FROM u WHERE n = 'o''brien'"),
    "SELECT * FROM u WHERE n = ?",
  );
  assert.equal(
    normalizeSql("SELECT * FROM u WHERE n = 'a\\'b'"),
    "SELECT * FROM u WHERE n = ?",
  );
});

test("does not treat -- inside a string as a comment", () => {
  assert.equal(
    normalizeSql("SELECT * FROM t WHERE s = 'a -- b' AND x = 1"),
    "SELECT * FROM t WHERE s = ? AND x = ?",
  );
});

test("strips line and block comments", () => {
  assert.equal(
    normalizeSql("SELECT a -- trailing\nFROM t /* inline */ WHERE b = 1"),
    "SELECT a FROM t WHERE b = ?",
  );
});

test("keeps quoted identifiers verbatim", () => {
  assert.equal(
    normalizeSql('SELECT "orderId" FROM "Order" WHERE "id" = 7'),
    'SELECT "orderId" FROM "Order" WHERE "id" = ?',
  );
  assert.equal(
    normalizeSql("SELECT `order_id` FROM `order` WHERE `id` = 7"),
    "SELECT `order_id` FROM `order` WHERE `id` = ?",
  );
});

test("normalizes every placeholder dialect to ?", () => {
  const expected = "SELECT * FROM t WHERE a = ? AND b = ?";
  assert.equal(normalizeSql("SELECT * FROM t WHERE a = $1 AND b = $2"), expected);
  assert.equal(normalizeSql("SELECT * FROM t WHERE a = ? AND b = ?"), expected);
  assert.equal(normalizeSql("SELECT * FROM t WHERE a = :a AND b = :b"), expected);
});

test("leaves the :: cast operator alone", () => {
  assert.equal(normalizeSql("SELECT id::text FROM t"), "SELECT id::text FROM t");
});

test("collapses variable-length IN lists to one placeholder", () => {
  assert.equal(
    normalizeSql("SELECT * FROM t WHERE id IN (1, 2, 3)"),
    normalizeSql("SELECT * FROM t WHERE id IN (7, 8)"),
  );
  assert.equal(
    normalizeSql("SELECT * FROM t WHERE id IN (1, 2, 3)"),
    "SELECT * FROM t WHERE id IN (?)",
  );
});

test("handles dollar-quoted strings", () => {
  assert.equal(
    normalizeSql("SELECT $$a -- not a comment$$ FROM t WHERE x = 1"),
    "SELECT ? FROM t WHERE x = ?",
  );
  assert.equal(
    normalizeSql("SELECT $body$ text $body$ FROM t"),
    "SELECT ? FROM t",
  );
});

test("collapses whitespace across lines", () => {
  assert.equal(
    normalizeSql("SELECT\n  a,\n  b\nFROM   t"),
    "SELECT a, b FROM t",
  );
});

test("classifies statements, seeing through CTEs", () => {
  assert.equal(statementKind("SELECT 1"), "select");
  assert.equal(statementKind("  insert into t values (1)"), "insert");
  assert.equal(statementKind("UPDATE t SET a = 1"), "update");
  assert.equal(statementKind("DELETE FROM t"), "delete");
  assert.equal(statementKind("WITH x AS (SELECT 1) SELECT * FROM x"), "select");
  assert.equal(statementKind("BEGIN"), "control");
  assert.equal(statementKind("VACUUM"), "other");
  assert.equal(statementKind("/* hint */ SELECT 1"), "select");
});

test("truncates long statements on a boundary", () => {
  assert.equal(truncateSql("SELECT 1", 100), "SELECT 1");
  const long = `SELECT ${"x".repeat(200)}`;
  const short = truncateSql(long, 20);
  assert.equal(short.length, 20);
  assert.ok(short.endsWith("…"));
});
