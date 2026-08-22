import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import { instrumentMssql } from "../src/adapters/mssql.js";

class FakeRequest {
  parameters: Record<string, { value: unknown }> = {};

  input(name: string, value: unknown): this {
    this.parameters[name] = { value };
    return this;
  }

  query(statement: string | TemplateStringsArray, ...values: unknown[]) {
    if (Array.isArray(statement) && "raw" in statement) {
      statement.forEach((_chunk, index) => {
        if (index < values.length) this.input(`param${index + 1}`, values[index]);
      });
    }
    return Promise.resolve({ recordset: [] });
  }

  // Independent of query(), as it is in the driver — delegating would let one
  // batch be recorded twice, which is not what the real class does.
  batch(_statement: string | TemplateStringsArray, ..._values: unknown[]) {
    return Promise.resolve({ recordset: [] });
  }

  execute(_procedure: string) {
    return Promise.resolve({ recordset: [] });
  }
}

class FakePreparedStatement {
  prepare(_statement: string) {
    return Promise.resolve(this);
  }

  execute(_values: Record<string, unknown>) {
    return Promise.resolve({ recordset: [] });
  }
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("detects an N+1 and records request input values", async () => {
  const restore = instrumentMssql({ Request: FakeRequest });
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (finding) => findings.push(finding) });

  await runInScope("GET /orders", async (scope) => {
    for (let id = 0; id < 7; id++) {
      await new FakeRequest()
        .input("id", id)
        .query("SELECT * FROM items WHERE order_id = @id");
    }
    assert.deepEqual(scope.queries[0]?.params, [0]);
  });

  restore();
  const finding = findings.find((candidate) => candidate.type === "n_plus_one");
  assert.equal(finding?.count, 7);
});

test("records tagged template values", async () => {
  const restore = instrumentMssql({ Request: FakeRequest });
  configure({ threshold: 1000 });

  await runInScope("tagged", async (scope) => {
    const id = 42;
    await new FakeRequest().query`SELECT * FROM users WHERE id = ${id}`;
    assert.deepEqual(scope.queries[0]?.params, [42]);
    assert.equal(scope.queries[0]?.normalized, "SELECT * FROM users WHERE id = ?");
  });

  restore();
});

test("records stored procedures as other operations and restores methods", async () => {
  const originalQuery = FakeRequest.prototype.query;
  const originalExecute = FakeRequest.prototype.execute;
  const restore = instrumentMssql({ Request: FakeRequest });
  configure({ threshold: 1000 });

  await runInScope("procedure", async (scope) => {
    await new FakeRequest().input("id", 9).execute("sp_GetUser");
    assert.equal(scope.queries[0]?.normalized, "sp_GetUser");
    assert.equal(scope.queries[0]?.kind, "other");
    assert.deepEqual(scope.queries[0]?.params, [9]);
  });

  restore();
  assert.equal(FakeRequest.prototype.query, originalQuery);
  assert.equal(FakeRequest.prototype.execute, originalExecute);
});

test("rejects a module without Request", () => {
  assert.throws(() => instrumentMssql({}), /expected the mssql module/);
});

test("detects an N+1 built by interpolation, with no bound parameters", async () => {
  const restore = instrumentMssql({ Request: FakeRequest });
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (finding) => findings.push(finding) });

  await runInScope("GET /orders", async (scope) => {
    for (let id = 0; id < 7; id++) {
      // No .input(): the values live in the SQL, which is what has to
      // discriminate the iterations.
      await new FakeRequest().query(`SELECT * FROM items WHERE order_id = ${id}`);
    }
    assert.equal(scope.queries[0]?.params, undefined);
  });

  restore();
  const finding = findings.find((candidate) => candidate.type === "n_plus_one");
  assert.equal(finding?.count, 7);
});

test("records batch statements", async () => {
  const restore = instrumentMssql({ Request: FakeRequest });
  configure({ threshold: 1000 });

  await runInScope("batch", async (scope) => {
    await new FakeRequest().batch("SELECT 1; SELECT 2");
    assert.equal(scope.queries.length, 1);
    assert.equal(scope.queries[0]?.sql, "SELECT 1; SELECT 2");
  });

  restore();
});

test("records a prepared statement with the SQL it was prepared with", async () => {
  const restore = instrumentMssql({
    Request: FakeRequest,
    PreparedStatement: FakePreparedStatement,
  });
  const findings: Finding[] = [];
  configure({ threshold: 5, onFinding: (finding) => findings.push(finding) });

  await runInScope("prepared", async (scope) => {
    const statement = new FakePreparedStatement();
    await statement.prepare("SELECT * FROM items WHERE order_id = @id");
    for (let id = 0; id < 6; id++) await statement.execute({ id });

    assert.equal(scope.queries.length, 6);
    assert.equal(scope.queries[0]?.sql, "SELECT * FROM items WHERE order_id = @id");
    assert.deepEqual(scope.queries[0]?.params, [0]);
  });

  restore();
  assert.equal(findings.find((f) => f.type === "n_plus_one")?.count, 6);
});

test("leaves a prepared statement alone when it was never prepared", async () => {
  const restore = instrumentMssql({
    Request: FakeRequest,
    PreparedStatement: FakePreparedStatement,
  });
  configure({ threshold: 1000 });

  await runInScope("unprepared", async (scope) => {
    await new FakePreparedStatement().execute({ id: 1 });
    assert.equal(scope.queries.length, 0);
  });

  restore();
});
