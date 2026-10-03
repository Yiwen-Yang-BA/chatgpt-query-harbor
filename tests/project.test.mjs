import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { run, validateSQL } from "../project.mjs";
import { ValidationError } from "../lib/validate.mjs";

const csv = "team,amount,id\nA,10,001\nA,20,002\nB,0,003\nB,,004";
const noModel = {
  generate: () => {
    throw new Error("Must not call model");
  },
};
const query = (sql, source = csv, context = noModel) =>
  run({ action: "query", csv: source, sql }, context);
const expensiveSQL =
  "SELECT COUNT(*) FROM dataset a CROSS JOIN dataset b CROSS JOIN dataset c CROSS JOIN dataset d CROSS JOIN dataset e CROSS JOIN dataset f";
const largeCSV =
  "value\n" + Array.from({ length: 100 }, (_, index) => index).join("\n");

test("inspect preserves leading-zero identifiers, infers REAL and maps only missing cells to null", async () => {
  const result = await run({ action: "inspect", csv }, noModel);
  assert.deepEqual(result.columns, [
    { name: "team", type: "TEXT" },
    { name: "amount", type: "REAL" },
    { name: "id", type: "TEXT" },
  ]);
  assert.deepEqual(result.preview[2], ["B", 0, "003"]);
  assert.deepEqual(result.preview[3], ["B", null, "004"]);
  assert.equal(result.rowCount, 4);
  await assert.rejects(
    run({ action: "inspect", csv: "Name,name\na,b" }, noModel),
    /忽略大小写/,
  );
});

test("real SQLite aggregate query handles sums, means, zero and null", async () => {
  const result = await query(
    "SELECT team, SUM(amount), AVG(amount), COUNT(amount) FROM dataset GROUP BY team ORDER BY team;",
  );
  assert.deepEqual(result.rows, [
    ["A", 30, 15, 2],
    ["B", 0, 0, 1],
  ]);
  assert.equal(result.sourceRows, 4);
  assert.equal(result.truncated, false);
  assert.deepEqual((await query("SELECT COUNT(*) FROM dataset")).rows, [[4]]);
});

test("quoted identifiers are safely imported and duplicate output names retain both values", async () => {
  const source = '"odd""name",select\nvalue,2';
  const result = await query(
    'SELECT "odd""name", "select" AS repeated, "select" + 1 AS repeated FROM dataset',
    source,
  );
  assert.deepEqual(result.columns, ['odd"name', "repeated", "repeated"]);
  assert.deepEqual(result.rows, [["value", 2, 3]]);
});

test("single-statement validation handles semicolons in strings and comments", async () => {
  assert.equal(
    validateSQL("SELECT ';' AS text; -- trailing ; comment"),
    "SELECT ';' AS text; -- trailing ; comment",
  );
  const result = await query(
    "/* before ; */ SELECT 'it''s;a' AS value; /* after ; */",
  );
  assert.deepEqual(result.rows, [["it's;a"]]);
  for (const sql of [
    "SELECT 1; SELECT 2",
    "SELECT 1;;",
    "DELETE FROM dataset",
    "PRAGMA table_info(dataset)",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "SELECT 'unclosed",
    "SELECT 1 /* unclosed",
  ])
    assert.throws(() => validateSQL(sql), ValidationError);
});

test("SQLite authorizer rejects schema access, extensions and non-allowlisted functions", async () => {
  for (const sql of [
    "SELECT name FROM sqlite_schema",
    "SELECT COUNT(*) FROM sqlite_master",
    "SELECT load_extension('anything')",
    "SELECT random()",
    "SELECT * FROM pragma_table_info('dataset')",
  ])
    await assert.rejects(query(sql), ValidationError);
  const result = await query(
    "SELECT ROUND(AVG(amount), 2), UPPER(team), COALESCE(amount, 0) FROM dataset WHERE team = 'B'",
  );
  assert.equal(result.rows[0][0], 0);
});

test("query returns at most 200 rows and accurately marks truncation", async () => {
  const source =
    "value\n" + Array.from({ length: 250 }, (_, index) => index).join("\n");
  const result = await query(
    "SELECT value FROM dataset ORDER BY value",
    source,
  );
  assert.equal(result.rowCount, 200);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows.at(-1), [199]);
  assert.equal(
    (await query("SELECT value FROM dataset LIMIT 200", source)).truncated,
    false,
  );
});

test(
  "native SQL timeout kills its isolated process before rejection",
  { timeout: 6000 },
  async (t) => {
    const originalFork = childProcess.fork;
    let child;
    t.mock.method(childProcess, "fork", (...args) => {
      child = originalFork(...args);
      return child;
    });
    await assert.rejects(query(expensiveSQL, largeCSV), /超过 2 秒/);
    assert.ok(child.pid);
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
    assert.throws(() => process.kill(child.pid, 0));
  },
);

test(
  "cancellation cleans up the child and never forwards the API-key environment",
  { timeout: 5000 },
  async (t) => {
    const originalFork = childProcess.fork;
    let child;
    let options;
    t.mock.method(childProcess, "fork", (...args) => {
      options = args[2];
      child = originalFork(...args);
      return child;
    });
    const controller = new AbortController();
    const pending = query(expensiveSQL, largeCSV, {
      ...noModel,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(pending, /取消/);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.deepEqual(options.execArgv, ["--max-old-space-size=64"]);
    assert.throws(() => process.kill(child.pid, 0));
  },
);

test("suggestion sends schema only and never executes or includes raw source values", async () => {
  let observed;
  const source = "category,amount\nPRIVATE_RAW_123,10";
  const result = await run(
    { action: "suggest", csv: source, question: "按分类汇总" },
    {
      generate: async (spec) => {
        observed = spec;
        return { data: await spec.demo() };
      },
    },
  );
  assert.ok(!observed.input.includes("PRIVATE_RAW_123"));
  assert.deepEqual(Object.keys(JSON.parse(observed.input)), [
    "table",
    "columns",
    "question",
  ]);
  assert.match(result.sql, /SUM\("amount"\)/);
  assert.match(result.warnings[0], /尚未执行/);
  const count = await run(
    { action: "suggest", csv, question: "一共多少行？" },
    { generate: async (spec) => ({ data: await spec.demo() }) },
  );
  assert.equal(count.sql, "SELECT COUNT(*) AS row_count FROM dataset;");
});

test("invalid inputs and unknown columns return clear errors without exposing query values", async () => {
  await assert.rejects(query("SELECT missing FROM dataset"), /查询列不存在/);
  await assert.rejects(query("SELECT " + "x".repeat(4001)), ValidationError);
  await assert.rejects(
    run({ action: "suggest", csv, question: "x".repeat(1001) }, noModel),
    ValidationError,
  );
  await assert.rejects(run({ action: "other", csv }, noModel), ValidationError);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    query("SELECT 1", csv, { ...noModel, signal: abort.signal }),
    /取消/,
  );
});
