import { DatabaseSync, constants } from "node:sqlite";

const FUNCTIONS = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "round",
  "abs",
  "length",
  "lower",
  "upper",
  "coalesce",
  "ifnull",
  "nullif",
]);
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

function safeError(error) {
  const message = String(error?.message || "");
  if (/no such column/i.test(message))
    return "查询列不存在，请检查列名并使用双引号引用特殊列名。";
  if (/no such table/i.test(message))
    return "查询表不存在；只允许读取 dataset。";
  if (/not authorized|prohibited|authorization|not allowed/i.test(message))
    return "查询访问了未授权的表或函数；只允许受控的 SELECT。";
  if (/no such function/i.test(message)) return "查询使用了不支持的函数。";
  if (/memory|too big|too large|too many|out of range|overflow/i.test(message))
    return "查询超出资源或数值限制，请简化查询。";
  return "SQL 无法执行，请检查语法、列名及允许的函数。";
}

process.once("message", ({ columns, rows, sql }) => {
  let db;
  let response;
  try {
    db = new DatabaseSync(":memory:", {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      limits: {
        length: 1000000,
        sqlLength: 5000,
        column: 100,
        exprDepth: 50,
        compoundSelect: 10,
        attach: 0,
        vdbeOp: 25000,
        functionArg: 50,
        variableNumber: 100,
        triggerDepth: 0,
      },
    });
    db.exec("PRAGMA temp_store=MEMORY; PRAGMA hard_heap_limit=67108864;");
    db.exec(
      `CREATE TABLE dataset (${columns.map((column) => `${quoteIdentifier(column.name)} ${column.type}`).join(", ")}) STRICT`,
    );
    const insert = db.prepare(
      `INSERT INTO dataset VALUES (${columns.map(() => "?").join(", ")})`,
    );
    db.exec("BEGIN");
    for (const row of rows) insert.run(...row);
    db.exec("COMMIT; PRAGMA query_only=ON;");
    db.setAuthorizer((action, arg1, arg2, database) => {
      if (action === constants.SQLITE_SELECT) return constants.SQLITE_OK;
      // COUNT(*) reports an empty column and null dbName for an implicit table
      // read. This process has exactly one dataset table and cannot attach or
      // create another schema after the authorizer is installed.
      if (
        action === constants.SQLITE_READ &&
        arg1 === "dataset" &&
        (database === "main" || (database === null && arg2 === ""))
      )
        return constants.SQLITE_OK;
      if (
        action === constants.SQLITE_FUNCTION &&
        FUNCTIONS.has(String(arg2 || arg1 || "").toLowerCase())
      )
        return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    });
    const statement = db.prepare(sql);
    statement.setReturnArrays(true);
    const names = statement.columns().map((column) => column.name);
    const resultRows = [];
    let truncated = false;
    for (const row of statement.iterate()) {
      if (resultRows.length >= 200) {
        truncated = true;
        break;
      }
      if (
        row.some(
          (value) =>
            (value !== null &&
              typeof value !== "string" &&
              typeof value !== "number") ||
            (typeof value === "number" && !Number.isFinite(value)),
        )
      )
        throw new Error("Result out of range");
      resultRows.push(row);
    }
    response = { ok: true, columns: names, rows: resultRows, truncated };
  } catch (error) {
    response = { ok: false, error: safeError(error) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
  if (process.connected)
    process.send(response, () => {
      process.disconnect();
    });
});

// The parent owns lifetime and forcibly terminates timed-out native queries.
process.on("disconnect", () => process.exit(0));
