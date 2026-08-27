"use strict";
/**
 * Excel reporter for the Appium suite.
 *
 * Same two-sheet shape as the Selenium reporter, plus two columns the mobile
 * suite needs to stay honest: the execution Mode of each case (device vs
 * contract) and the Screen / Selector it drives. A reader must never have to
 * guess whether a green row involved a real device.
 */

const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const BRAND = {
  header: "FF1B5E20",
  pass: "FFD1FAE5",
  fail: "FFFEE2E2",
  skip: "FFF3F4F6",
  white: "FFFFFFFF",
  note: "FFFFF7E6",
};

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: BRAND.white }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND.header } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin" }, left: { style: "thin" },
      bottom: { style: "thin" }, right: { style: "thin" },
    };
  });
  row.height = 26;
}

function statusFill(status) {
  if (status === "PASS") return BRAND.pass;
  if (status === "FAIL") return BRAND.fail;
  return BRAND.skip;
}

async function writeReport({ outFile, title, meta, results, disclosure }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MediGuard automated test suite";
  wb.created = new Date();

  // ── Sheet 1: Test Summary ────────────────────────────────────────────────
  const summary = wb.addWorksheet("Test Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  summary.columns = [
    { header: "Metric", key: "metric", width: 36 },
    { header: "Value", key: "value", width: 76 },
  ];
  styleHeader(summary.getRow(1));

  const total = results.length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  const totalMs = results.reduce((a, r) => a + (r.durationMs || 0), 0);
  const passRate = total ? ((passed / total) * 100).toFixed(2) + "%" : "n/a";

  const rows = [
    ["Report", title],
    ["Generated at", new Date().toISOString()],
    ...Object.entries(meta).map(([k, v]) => [k, String(v)]),
    ["", ""],
    ["Total test cases", total],
    ["Passed", passed],
    ["Failed", failed],
    ["Skipped", skipped],
    ["Pass rate", passRate],
    ["Total execution time", (totalMs / 1000).toFixed(2) + " s"],
    ["", ""],
  ];
  rows.forEach(([metric, value]) => summary.addRow({ metric, value }));

  // The scope disclosure is part of the report, not a footnote in a README.
  if (disclosure) {
    const dh = summary.addRow({ metric: "SCOPE OF THIS RUN", value: "" });
    styleHeader(dh);
    for (const line of disclosure) {
      const r = summary.addRow({ metric: "", value: line });
      r.getCell("value").alignment = { wrapText: true, vertical: "top" };
      r.getCell("value").fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND.note } };
    }
    summary.addRow({ metric: "", value: "" });
  }

  const sh = summary.addRow({ metric: "Suite", value: "Passed / Total" });
  styleHeader(sh);

  const bySuite = new Map();
  for (const r of results) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, { pass: 0, fail: 0, total: 0 });
    const s = bySuite.get(r.suite);
    s.total++;
    if (r.status === "PASS") s.pass++;
    else if (r.status === "FAIL") s.fail++;
  }
  for (const [name, s] of bySuite) {
    const row = summary.addRow({ metric: name, value: `${s.pass} / ${s.total}` });
    row.getCell("value").fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: s.fail > 0 ? BRAND.fail : BRAND.pass },
    };
  }

  // ── Sheet 2: Test Details ────────────────────────────────────────────────
  const details = wb.addWorksheet("Test Details", { views: [{ state: "frozen", ySplit: 1 }] });
  details.columns = [
    { header: "Test ID", key: "id", width: 12 },
    { header: "Suite", key: "suite", width: 26 },
    { header: "Screen", key: "screen", width: 18 },
    { header: "Test Case Title", key: "title", width: 50 },
    { header: "Appium Selector", key: "selector", width: 44 },
    { header: "Test Steps", key: "steps", width: 54 },
    { header: "Expected Result", key: "expected", width: 42 },
    { header: "Actual Result", key: "actual", width: 44 },
    { header: "Mode", key: "mode", width: 10 },
    { header: "Status", key: "status", width: 10 },
    { header: "Duration (ms)", key: "durationMs", width: 13 },
    { header: "Error", key: "error", width: 44 },
  ];
  styleHeader(details.getRow(1));

  for (const r of results) {
    const row = details.addRow({
      id: r.id,
      suite: r.suite,
      screen: r.screen || "-",
      title: r.title,
      selector: r.selector || "-",
      steps: Array.isArray(r.steps) ? r.steps.join("\n") : r.steps || "",
      expected: r.expected || "",
      actual: r.actual || "",
      mode: r.mode,
      status: r.status,
      durationMs: r.durationMs ?? 0,
      error: r.error || "",
    });
    row.alignment = { vertical: "top", wrapText: true };
    const cell = row.getCell("status");
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: statusFill(r.status) } };
    cell.font = { bold: true };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }

  details.autoFilter = { from: "A1", to: "L1" };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await wb.xlsx.writeFile(outFile);
  return { total, passed, failed, skipped, passRate, totalMs };
}

module.exports = { writeReport };
