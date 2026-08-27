"use strict";
/**
 * Excel reporter shared by the Selenium suite.
 *
 * Produces a single workbook with two sheets:
 *   "Test Summary"  -- one row per suite plus a grand total, and the run metadata
 *                      (browser, base URL, start/end, duration) that makes a
 *                      result reproducible six months later.
 *   "Test Details"  -- one row per test case: id, suite, title, steps, expected,
 *                      actual, status, duration, and the error when one occurred.
 *
 * ExcelJS is used rather than SheetJS because the npm-published SheetJS build is
 * frozen at 0.18.5 with open advisories, and this repo is scanned by the same
 * CI pipeline that runs these tests -- a test harness must not be the thing that
 * fails the dependency audit.
 */

const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const BRAND = {
  header: "FF1B5E20",   // deep green -- matches Colors.primary in packages/shared
  pass: "FFD1FAE5",
  fail: "FFFEE2E2",
  skip: "FFF3F4F6",
  white: "FFFFFFFF",
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

/**
 * @param {object} opts
 * @param {string} opts.outFile      absolute path of the .xlsx to write
 * @param {string} opts.title        workbook title, e.g. "MediGuard Selenium E2E"
 * @param {object} opts.meta         run metadata (browser, baseUrl, ...)
 * @param {Array}  opts.results      [{ id, suite, title, steps, expected, actual,
 *                                      status, durationMs, error, severity, type }]
 */
async function writeReport({ outFile, title, meta, results }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MediGuard automated test suite";
  wb.created = new Date();

  // ── Sheet 1: Test Summary ────────────────────────────────────────────────
  const summary = wb.addWorksheet("Test Summary", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  summary.columns = [
    { header: "Metric", key: "metric", width: 34 },
    { header: "Value", key: "value", width: 58 },
  ];
  styleHeader(summary.getRow(1));

  const total = results.length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  const totalMs = results.reduce((a, r) => a + (r.durationMs || 0), 0);
  const passRate = total ? ((passed / total) * 100).toFixed(2) + "%" : "n/a";

  const metaRows = [
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
  metaRows.forEach(([metric, value]) => summary.addRow({ metric, value }));

  // Per-suite breakdown table, below the metadata block.
  const suiteHeaderRow = summary.addRow({ metric: "Suite", value: "Passed / Total" });
  styleHeader(suiteHeaderRow);

  const bySuite = new Map();
  for (const r of results) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, { pass: 0, fail: 0, skip: 0, total: 0 });
    const s = bySuite.get(r.suite);
    s.total++;
    if (r.status === "PASS") s.pass++;
    else if (r.status === "FAIL") s.fail++;
    else s.skip++;
  }
  for (const [name, s] of bySuite) {
    const row = summary.addRow({ metric: name, value: `${s.pass} / ${s.total}` });
    row.getCell("value").fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: s.fail > 0 ? BRAND.fail : BRAND.pass },
    };
  }

  summary.getColumn("metric").font = { size: 11 };

  // ── Sheet 2: Test Details ────────────────────────────────────────────────
  const details = wb.addWorksheet("Test Details", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  details.columns = [
    { header: "Test ID", key: "id", width: 14 },
    { header: "Suite", key: "suite", width: 26 },
    { header: "Test Case Title", key: "title", width: 52 },
    { header: "Test Steps", key: "steps", width: 60 },
    { header: "Expected Result", key: "expected", width: 42 },
    { header: "Actual Result", key: "actual", width: 42 },
    { header: "Status", key: "status", width: 10 },
    { header: "Duration (ms)", key: "durationMs", width: 14 },
    { header: "Error", key: "error", width: 46 },
  ];
  styleHeader(details.getRow(1));

  for (const r of results) {
    const row = details.addRow({
      id: r.id,
      suite: r.suite,
      title: r.title,
      steps: Array.isArray(r.steps) ? r.steps.join("\n") : r.steps || "",
      expected: r.expected || "",
      actual: r.actual || "",
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

  details.autoFilter = { from: "A1", to: "I1" };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await wb.xlsx.writeFile(outFile);
  return { total, passed, failed, skipped, passRate, totalMs };
}

module.exports = { writeReport };
