import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, runInScope, type Finding } from "../src/index.js";
import {
  instrumentOracle,
  instrumentOracleConnection,
} from "../src/adapters/oracledb.js";

/**
 * `oracledb` is a native module, so CI cannot install it and these run against
 * a fake. The fake mirrors the driver's documented public surface — the module
 * hands out connections through `getConnection()` and `createPool()`, and a
 * connection has `execute`, `executeMany` and `queryStream` — which is the only
 * part the adapter touches. It deliberately does not export its `Connection`
 * class, which is why the adapter reaches the prototype through an instance,
 * and why the fake is built the same way.
 */

class FakeConnection {
  execute(_sql: string, _binds?: unknown, _options?: unknown) {
    return Promise.resolve({ rows: [] });
  }

  executeMany(_sql: string, _binds: unknown, _options?: unknown) {
    return Promise.resolve({ rowsAffected: 0 });
  }

  queryStream(_sql: string, _binds?: unknown) {
    return { on: () => undefined };
  }
}

class FakePool {
  getConnection() {
    return Promise.resolve(new FakeConnection());
  }
}

function fakeModule() {
  return {
    getConnection: (_config?: unknown) => Promise.resolve(new FakeConnection()),
    createPool: (_config?: unknown) => Promise.resolve(new FakePool()),
  };
}

beforeEach(() => {
  resetConfig();
  configure({ mode: "silent", enabled: true, threshold: 5 });
});

test("detects an N+1 through a connection handed out by the module", async () => {
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("GET /orders", async (scope) => {
    const connection = await oracledb.getConnection();
    for (let id = 0; id < 7; id++) {
      await connection.execute("SELECT * FROM items WHERE order_id = :id", { id });
    }
    assert.deepEqual(scope.queries[0]?.params, [0]);
    assert.equal(scope.queries[0]?.kind, "select");
  });

  restore();
  assert.equal(findings.find((f) => f.type === "n_plus_one")?.count, 7);
});

test("positional binds are recorded too", async () => {
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);

  await runInScope("positional", async (scope) => {
    const connection = await oracledb.getConnection();
    await connection.execute("SELECT * FROM items WHERE id = :1", [42]);
    assert.deepEqual(scope.queries[0]?.params, [42]);
  });

  restore();
});

test("a statement with no binds reports no parameters, so the SQL discriminates", async () => {
  // The mssql regression, guarded here: reporting `[]` would give every
  // iteration the same discriminator and a loop that concatenates its ids into
  // the SQL — the code most likely to have an N+1 — would never be reported.
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("interpolated", async (scope) => {
    const connection = await oracledb.getConnection();
    for (let id = 0; id < 7; id++) {
      await connection.execute(`SELECT * FROM items WHERE order_id = ${id}`);
    }
    assert.equal(scope.queries[0]?.params, undefined);
  });

  restore();
  assert.equal(findings.find((f) => f.type === "n_plus_one")?.count, 7);
});

test("a pooled connection is recorded once, not twice", async () => {
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);

  await runInScope("pooled", async (scope) => {
    const pool = await oracledb.createPool();
    const connection = await pool.getConnection();
    await connection.execute("SELECT 1 FROM dual");
    assert.equal(scope.queryCount, 1, "the pool must not record on its own");
  });

  restore();
});

test("executeMany records each row as its own statement, in one round trip", async () => {
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);

  await runInScope("batch", async (scope) => {
    const connection = await oracledb.getConnection();
    await connection.executeMany("INSERT INTO items (id, name) VALUES (:1, :2)", [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);

    assert.equal(scope.queryCount, 3);
    assert.deepEqual(scope.queries[1]?.params, [2, "b"]);
    // Divided evenly rather than nested, so the sum stays the measurement.
    const total = scope.queries.reduce((sum, q) => sum + (q.durationMs ?? 0), 0);
    assert.ok(total >= 0 && Number.isFinite(total));
  });

  restore();
});

test("executeMany with a numIterations count records one statement", async () => {
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);

  await runInScope("iterations", async (scope) => {
    const connection = await oracledb.getConnection();
    await connection.executeMany("BEGIN my_proc(); END;", 5);
    assert.equal(scope.queryCount, 1);
    assert.equal(scope.queries[0]?.params, undefined);
  });

  restore();
});

test("an anonymous PL/SQL block is not mistaken for transaction control", async () => {
  // `BEGIN` reads as control to the shared classifier, and control is dropped
  // before it reaches a scope — so a PL/SQL block running once per row would
  // have gone missing entirely, and silently.
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);
  const findings: Finding[] = [];
  configure({ onFinding: (finding) => findings.push(finding) });

  await runInScope("plsql", async (scope) => {
    const connection = await oracledb.getConnection();
    for (let id = 0; id < 7; id++) {
      await connection.execute("BEGIN load_items(:id); END;", { id });
    }
    assert.equal(scope.queryCount, 7);
    assert.equal(scope.queries[0]?.kind, "other");
  });

  restore();
  assert.equal(findings.find((f) => f.type === "n_plus_one")?.count, 7);
});

test("COMMIT is still treated as transaction control", async () => {
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);

  await runInScope("commit", async (scope) => {
    const connection = await oracledb.getConnection();
    await connection.execute("COMMIT");
    assert.equal(scope.queryCount, 0);
  });

  restore();
});

test("queryStream is recorded when the stream is opened", async () => {
  const oracledb = fakeModule();
  const restore = instrumentOracle(oracledb);

  await runInScope("stream", async (scope) => {
    const connection = await oracledb.getConnection();
    connection.queryStream("SELECT * FROM items WHERE order_id = :id", { id: 1 });
    assert.equal(scope.queryCount, 1);
    assert.deepEqual(scope.queries[0]?.params, [1]);
  });

  restore();
});

test("the callback form of getConnection is covered", async () => {
  const oracledb = {
    getConnection: (_config: unknown, callback: (e: unknown, c: unknown) => void) => {
      callback(null, new FakeConnection());
    },
  };
  const restore = instrumentOracle(oracledb as never);

  await runInScope("callback", async (scope) => {
    await new Promise<void>((resolve) => {
      (oracledb.getConnection as never as (c: unknown, cb: (e: unknown, c: unknown) => void) => void)(
        {},
        (_error, connection) => {
          void (connection as FakeConnection)
            .execute("SELECT 1 FROM dual")
            .then(() => resolve());
        },
      );
    });
    assert.equal(scope.queryCount, 1);
  });

  restore();
});

test("instrumenting twice does not double count, and restore puts it back", async () => {
  const oracledb = fakeModule();
  const original = FakeConnection.prototype.execute;

  const restoreA = instrumentOracle(oracledb);
  const restoreB = instrumentOracle(oracledb);

  await runInScope("twice", async (scope) => {
    const connection = await oracledb.getConnection();
    await connection.execute("SELECT 1 FROM dual");
    assert.equal(scope.queryCount, 1);
  });

  restoreB();
  restoreA();
  assert.equal(FakeConnection.prototype.execute, original);
});

test("instrumentOracleConnection covers a connection you already have", async () => {
  const connection = new FakeConnection();
  const restore = instrumentOracleConnection(connection);

  await runInScope("direct", async (scope) => {
    await connection.execute("SELECT 1 FROM dual");
    assert.equal(scope.queryCount, 1);
  });

  restore();
});

test("rejects something that is not the oracledb module", () => {
  assert.throws(() => instrumentOracle({}), /expected the oracledb module/);
});
