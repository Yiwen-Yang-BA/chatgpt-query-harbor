import {
  $,
  escape,
  toast,
  download,
  csv,
  init,
  run,
  busy,
  resultMeta,
  fileText,
} from "./ui.js";
const sample =
  "region,product,amount,quantity\n华东,分析软件,1200,3\n华北,数据服务,800,2\n华南,分析软件,950,2\n华东,数据服务,600,1\n华北,分析软件,1600,4\n华南,数据服务,450,1\n华东,培训,900,3\n华北,培训,300,1\n";
let dataset = null;
let result = null;
let pending = false;
let dirty = true;
function lock(on) {
  pending = on;
  document
    .querySelectorAll(
      "input,textarea,select,#sample,#inspect,#suggest,#execute,#count-query",
    )
    .forEach((el) => (el.disabled = on));
  ["#suggest", "#execute", "#count-query"].forEach(
    (id) => ($(id).disabled = on || dirty || !dataset),
  );
}
function table(columns, rows) {
  return `<table class="data-table"><thead><tr>${columns.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${v === null ? '<span class="chip">NULL</span>' : escape(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
async function inspect() {
  if (pending) return;
  const source = $("#csv").value;
  lock(true);
  busy($("#inspect"), true, "读取中…");
  try {
    const r = await run({ action: "inspect", csv: source }, { mode: "demo" });
    dataset = { ...r.data, csv: source };
    dirty = false;
    $("#schema").innerHTML = dataset.columns
      .map(
        (c) =>
          `<div class="row between"><code>${escape(c.name)}</code><span class="chip">${escape(c.type)}</span></div>`,
      )
      .join("");
    $("#preview").innerHTML = table(
      dataset.columns.map((c) => c.name),
      dataset.preview,
    );
    $("#dataset-state").textContent =
      `${dataset.rowCount} 行 · ${dataset.columns.length} 列`;
    if (!$("#sql").value.trim())
      $("#sql").value = "SELECT * FROM dataset LIMIT 20;";
    if (result) $("#query-status").textContent = "上一轮结果 · 数据已重新读取";
  } catch (err) {
    dirty = true;
    toast(err.message, true);
  } finally {
    busy($("#inspect"), false);
    lock(false);
  }
}
$("#inspect").onclick = inspect;
$("#csv").oninput = () => {
  dirty = true;
  $("#dataset-state").textContent = "数据已更改，请重新读取";
  lock(false);
};
$("#sample").onclick = async () => {
  $("#csv").value = sample;
  $("#question").value = "按 region 分组，统计 amount 的合计";
  dirty = true;
  await inspect();
};
$("#file").onchange = async (e) => {
  if (pending) return;
  lock(true);
  let loaded = false;
  try {
    const f = e.target.files[0];
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) throw Error("请选择 CSV 文件");
    const text = await fileText(f, 750000);
    if (text.length > 250000) throw Error("CSV 超过 250,000 字符");
    $("#csv").value = text;
    dirty = true;
    loaded = true;
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.value = "";
    lock(false);
  }
  if (loaded) await inspect();
};
$("#suggest-form").onsubmit = async (e) => {
  e.preventDefault();
  if (pending || !dataset || dirty) return;
  lock(true);
  busy($("#suggest"), true, "生成草稿中…");
  try {
    const r = await run({
      action: "suggest",
      csv: dataset.csv,
      question: $("#question").value,
    });
    $("#sql").value = r.data.sql;
    $("#explanation").textContent =
      r.data.explanation +
      (r.data.warnings?.length ? " " + r.data.warnings.join(" ") : "");
    $("#meta").innerHTML = resultMeta(r.meta);
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy($("#suggest"), false);
    lock(false);
  }
};
$("#count-query").onclick = () => {
  $("#sql").value = "SELECT COUNT(*) AS row_count FROM dataset;";
};
$("#query-form").onsubmit = async (e) => {
  e.preventDefault();
  if (pending || !dataset || dirty) return;
  const sql = $("#sql").value;
  $("#toast").hidden = true;
  lock(true);
  busy($("#execute"), true, "执行查询中…");
  try {
    const r = await run(
      { action: "query", csv: dataset.csv, sql },
      { mode: "demo" },
    );
    result = r.data;
    $("#results").innerHTML = table(result.columns, result.rows);
    $("#query-status").textContent =
      `${result.rowCount} 行 · ${Math.round(result.durationMs)} ms`;
    $("#result-sql").textContent = "本次执行：" + result.sql;
    $("#warnings").textContent =
      result.warnings.join("\n") +
      (result.truncated
        ? "\n结果超过 200 行，当前仅显示并导出前 200 行。"
        : "");
    $("#exports").hidden = false;
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy($("#execute"), false);
    lock(false);
  }
};
$("#export-csv").onclick = () => {
  if (result)
    download(
      "query-results.csv",
      csv([result.columns, ...result.rows]),
      "text/csv;charset=utf-8",
    );
};
$("#export-sql").onclick = () => {
  if (result)
    download("executed-query.sql", result.sql + "\n", "application/sql");
};
$("#export-json").onclick = () => {
  if (result)
    download(
      "query-snapshot.json",
      JSON.stringify(result, null, 2),
      "application/json",
    );
};
await init();
lock(false);
