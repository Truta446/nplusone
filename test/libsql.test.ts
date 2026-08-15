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

class FakeLibsqlTransaction {
  executeCalls = 0;
  batchCalls = 0;
  executeMultipleCalls = 0;
  commitCalls = 0;
  rollbackCalls = 0;

  execute(_statement: Statement): Promise<{ rows: unknown[] }> {
    this.executeCalls += 1;
    return Promise.resolve({ rows: [] });
  }

  batch(statements: Statement[]): Promise<Array<{ rows: unknown[] }>> {
    this.batchCalls += 1;
    return Promise.resolve(statements.map(() => ({ rows: [] })));
  }

  executeMultiple(_sql: string): Promise<void> {
    this.executeMultipleCalls += 1;
    return Promise.resolve();
  }

  commit(): Promise<{ ok: true }> {
    this.commitCalls += 1;
    return Promise.resolve({ ok: true });
  }

  rollback(): Promise<{ ok: false }> {
    this.rollbackCalls += 1;
    return Promise.resolve({ ok: false });
  }
}

class FakeLibsqlClient {
  executeCalls = 0;
  batchCalls = 0;
  executeMultipleCalls = 0;
  lastTransaction: FakeLibsqlTransaction | undefined;

  execute(_statement: Statement): Promise<{ rows: unknown[] }> {
    this.executeCalls += 1;
    return Promise.resolve({ rows: [] });
  }

  batch(statements: Statement[]): Promise<Array<{ rows: unknown[] }>> {
    this.batchCalls += 1;
    return Promise.resolve(statements.map(() => ({ rows: [] })));
  }

  transaction(_mode?: string): Promise<FakeLibsqlTransaction> {
    this.lastTransaction = new FakeLibsqlTransaction();
    return Promise.resolve(this.lastTransaction);
  }

  executeMultiple(_sql: string): Promise<void> {
    this.executeMultipleCalls += 1;
    return Promise.resolve();
  }
}

/** Takes a measurable amount of time, so timings can be asserted on. */
class SlowLibsqlClient extends FakeLibsqlClient {
  static readonly DELAY_MS = 40;

  override async batch(
    statements: Statement[],
  ): Promise<Array<{ rows: unknown[] }>> {
    await new Promise((resolve) => setTimeout(resolve, SlowLibsqlClient.DELAY_MS));
    return super.batch(statements);
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

test("does not multiply the time a batch actually took", async () => {
  const client = new SlowLibsqlClient();
  const restore = instrumentLibsql(client);
  configure({ threshold: 1000 });

  const statements = Array.from({ length: 5 }, (_, id) => ({
    sql: "SELECT * FROM items WHERE order_id = ?",
    args: [id],
  }));

  let elapsed = 0;
  let reported = 0;
  await runInScope("timing", async (scope) => {
    const started = performance.now();
    await client.batch(statements);
    elapsed = performance.now() - started;
    reported = scope.queries.reduce((sum, query) => sum + (query.durationMs ?? 0), 0);
  });
  restore();

  // Wrapping each statement in its own observe() nests the timers, so every
  // outer one contains all the inner ones and five statements report roughly
  // five times the truth. The batch is one round trip: the total is what the
  // round trip cost, however it is divided between the statements.
  assert.ok(
    reported <= elapsed * 1.5,
    `reported ${reported.toFixed(1)}ms for a batch that took ${elapsed.toFixed(1)}ms`,
  );
  assert.ok(reported > 0, "a batch that took real time must report some of it");
});

test("rejects an invalid client", () => {
  assert.throws(
    () => instrumentLibsql({} as never),
    /expected a client with execute\(\) and batch\(\)/,
  );
});

test("records queries issued through a transaction", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  configure({ threshold: 1000 });

  await runInScope("tx", async (scope) => {
    const tx = await client.transaction("write");
    await tx.execute("INSERT INTO t VALUES (?)");
    await tx.execute({
      sql: "INSERT INTO t VALUES (?)",
      args: [2],
    });
    await tx.batch(["SELECT 1", "SELECT 2"]);

    assert.equal(scope.queryCount, 4);
    assert.equal(scope.queries[0]!.sql, "INSERT INTO t VALUES (?)");
    assert.deepEqual(scope.queries[1]!.params, [2]);
    assert.equal(scope.queries[2]!.sql, "SELECT 1");
    assert.equal(scope.queries[3]!.sql, "SELECT 2");
  });

  restore();
  assert.equal(client.lastTransaction?.executeCalls, 2);
  assert.equal(client.lastTransaction?.batchCalls, 1);
});

test("detects an N+1 inside a transaction", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  const findings: Finding[] = [];
  configure({ threshold: 4, onFinding: (finding) => findings.push(finding) });

  await runInScope("tx-n1", async () => {
    const tx = await client.transaction("write");
    for (const id of [1, 2, 3, 4, 5, 6]) {
      await tx.execute({
        sql: "SELECT * FROM items WHERE order_id = ?",
        args: [id],
      });
    }
  });

  restore();
  assert.equal(findings.filter((finding) => finding.type === "n_plus_one").length, 1);
});

test("leaves transaction commit and rollback untouched", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);

  const tx = await client.transaction("write");
  const committed = await tx.commit();
  const rolledBack = await tx.rollback();

  restore();
  assert.deepEqual(committed, { ok: true });
  assert.deepEqual(rolledBack, { ok: false });
  assert.equal(client.lastTransaction?.commitCalls, 1);
  assert.equal(client.lastTransaction?.rollbackCalls, 1);
});

test("records executeMultiple as one statement, even with interior semicolons", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  configure({ threshold: 1000 });

  const script =
    "INSERT INTO t VALUES ('a;b'); INSERT INTO t VALUES ('c'); CREATE TRIGGER x AFTER INSERT ON t BEGIN UPDATE t SET n = n + 1; END;";

  await runInScope("script", async (scope) => {
    await client.executeMultiple(script);

    assert.equal(scope.queryCount, 1, "the script is one observation, not a split");
    assert.equal(scope.queries[0]!.sql, script);
  });

  restore();
  assert.equal(client.executeMultipleCalls, 1);
});

test("restore stops wrapping new transactions", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  restore();

  await runInScope("restored-tx", async (scope) => {
    const tx = await client.transaction("write");
    await tx.execute("SELECT 1");
    assert.equal(scope.queryCount, 0);
  });
});

test("records executeMultiple issued through a transaction as one statement", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  configure({ threshold: 1000 });

  const script = "INSERT INTO t VALUES ('a;b'); INSERT INTO t VALUES ('c');";

  await runInScope("tx-script", async (scope) => {
    const tx = await client.transaction("write");
    await tx.executeMultiple(script);

    assert.equal(scope.queryCount, 1);
    assert.equal(scope.queries[0]!.sql, script);
  });

  restore();
  assert.equal(client.lastTransaction?.executeMultipleCalls, 1);
});

test("restore unpatches an already-resolved transaction", async () => {
  const client = new FakeLibsqlClient();
  const restore = instrumentLibsql(client);
  const tx = await client.transaction("write");
  restore();

  await runInScope("restored-live-tx", async (scope) => {
    await tx.execute("SELECT 1");
    await tx.executeMultiple("SELECT 2");
    assert.equal(scope.queryCount, 0);
  });
});

test("a transaction that resolves after restore is not patched", async () => {
  let resolveTx!: (tx: FakeLibsqlTransaction) => void;
  const client = new FakeLibsqlClient();
  client.transaction = () =>
    new Promise<FakeLibsqlTransaction>((resolve) => {
      resolveTx = resolve;
    });

  const restore = instrumentLibsql(client);
  const pending = client.transaction();
  restore();

  const late = new FakeLibsqlTransaction();
  resolveTx(late);
  const tx = await pending;

  await runInScope("restored-pending-tx", async (scope) => {
    await tx.execute("SELECT 1");
    await tx.executeMultiple("SELECT 2");
    assert.equal(scope.queryCount, 0);
  });
});
