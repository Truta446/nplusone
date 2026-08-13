import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import { instrumentLibsql } from "../src/adapters/libsql.js";

type Statement =
  | string
  | {
      sql: string;
      args?: readonly unknown[] | Record<string, unknown>;
    };

class FakeLibsqlClient {
  executeCalls = 0;
  batchCalls = 0;

  execute(_statement: Statement): Promise<{ rows: unknown[] }> {
    this.executeCalls += 1;
    return Promise.resolve({ rows: [] });
  }

  batch(statements: Statement[]): Promise<Array<{ rows: unknown[] }>> {
    this.batchCalls += 1;
    return Promise.resolve(statements.map(() => ({ rows: [] })));
  }
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true });
});

test("records string and object execute call shapes", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  configure({ threshold: 1000 });

  await runInScope("execute", async (scope) => {
    await client.execute("SELECT 1");
    await client.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [7],
    });
    await client.execute({
      sql: "SELECT * FROM users WHERE id = :id",
      args: { id: 8 },
    });

    assert.equal(scope.queryCount, 3);
    assert.equal(scope.queries[0]!.sql, "SELECT 1");
    assert.deepEqual(scope.queries[1]!.params, [7]);
    assert.deepEqual(scope.queries[2]!.params, [{ id: 8 }]);
  });

  restore();
  assert.equal(client.executeCalls, 3, "the original execute method still ran");
});

test("records each statement in a batch separately", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  const findings: Finding[] = [];
  configure({ threshold: 4, onFinding: (finding) => findings.push(finding) });

  await runInScope("batch", async (scope) => {
    await client.batch(
      Array.from({ length: 6 }, (_, id) => ({
        sql: "SELECT * FROM items WHERE order_id = ?",
        args: [id],
      })),
    );

    assert.equal(scope.queryCount, 6);
    assert.deepEqual(
      scope.queries.map((query) => query.params),
      [[0], [1], [2], [3], [4], [5]],
    );
  });

  restore();
  assert.equal(client.batchCalls, 1, "one batch remains one driver call");
  assert.equal(findings.filter((finding) => finding.type === "n_plus_one").length, 1);
});

test("restore stops recording", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  restore();

  await runInScope("restored", async (scope) => {
    await client.execute("SELECT 1");
    assert.equal(scope.queryCount, 0);
  });
});

test("instrumenting twice does not double count", async () => {
  const client = new FakeLibsqlClient();
  const restoreA = instrumentLibsql(client);
  const restoreB = instrumentLibsql(client);
  configure({ threshold: 1000 });

  await runInScope("double", async (scope) => {
    await client.execute("SELECT 1");
    assert.equal(scope.queryCount, 1);
  });

  restoreB();
  restoreA();
});

test("rejects an invalid client", () => {
  assert.throws(
    () => instrumentLibsql({} as never),
    /expected a client with execute\(\) and batch\(\)/,
  );
});
