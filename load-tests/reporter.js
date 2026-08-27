"use strict";
/**
 * Excel reporter for the load suite.
 *
 * Four sheets:
 *   Test Summary        run metadata, SLO thresholds, per-scenario pass counts
 *   Performance Metrics one row per scenario with the full RPS/latency profile
 *   Test Details        one row per assertion (aggregate metrics + 1s windows)
 *   Throughput Timeline one row per second per scenario, for spotting collapses
 */

const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const BRAND = {
  header: "FF1B5E20",
  pass: "FFD1FAE5",
  fail: "FFFEE2E2",
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

async function writeReport({ outFile, title, meta, slo, scenarios, cases }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MediGuard automated test suite";
  wb.created = new Date();

  const total = cases.length;
  const passed = cases.filter((c) => c.status === "PASS").length;
  const failed = cases.filter((c) => c.status === "FAIL").length;
  const passRate = total ? ((passed / total) * 100).toFixed(2) + "%" : "n/a";

  // ── Sheet 1: Test Summary ────────────────────────────────────────────────
  const summary = wb.addWorksheet("Test Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  summary.columns = [
    { header: "Metric", key: "metric", width: 38 },
    { header: "Value", key: "value", width: 70 },
  ];
  styleHeader(summary.getRow(1));

  [
    ["Report", title],
    ["Generated at", new Date().toISOString()],
    ...Object.entries(meta).map(([k, v]) => [k, String(v)]),
    ["", ""],
    ["Total assertions", total],
    ["Passed", passed],
    ["Failed", failed],
    ["Pass rate", passRate],
    ["", ""],
  ].forEach(([metric, value]) => summary.addRow({ metric, value }));

  const sloHeader = summary.addRow({ metric: "SERVICE LEVEL OBJECTIVE", value: "Threshold" });
  styleHeader(sloHeader);
  [
    ["Minimum sustained throughput", `${slo.minRps} req/sec`],
    ["Maximum mean latency", `${slo.maxMeanLatency} ms`],
    ["Maximum p99 latency", `${slo.maxP99Latency} ms`],
    ["Maximum error rate", (slo.maxErrorRate * 100).toFixed(2) + "%"],
    ["Maximum non-2xx rate", (slo.maxNon2xxRate * 100).toFixed(2) + "%"],
    ["Minimum requests per 1s window", `${slo.minWindowRps}`],
  ].forEach(([metric, value]) => summary.addRow({ metric, value }));

  summary.addRow({ metric: "", value: "" });
  const sh = summary.addRow({ metric: "Scenario", value: "Passed / Total" });
  styleHeader(sh);

  const bySuite = new Map();
  for (const c of cases) {
    if (!bySuite.has(c.suite)) bySuite.set(c.suite, { pass: 0, total: 0 });
    const s = bySuite.get(c.suite);
    s.total++;
    if (c.status === "PASS") s.pass++;
  }
  for (const [name, s] of bySuite) {
    const row = summary.addRow({ metric: name, value: `${s.pass} / ${s.total}` });
    row.getCell("value").fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: s.pass === s.total ? BRAND.pass : BRAND.fail },
    };
  }

  // ── Sheet 2: Performance Metrics ─────────────────────────────────────────
  const perf = wb.addWorksheet("Performance Metrics", { views: [{ state: "frozen", ySplit: 1 }] });
  perf.columns = [
    { header: "Scenario", key: "name", width: 32 },
    { header: "Endpoint", key: "endpoint", width: 30 },
    { header: "Virtual Users", key: "connections", width: 13 },
    { header: "Duration (s)", key: "duration", width: 12 },
    { header: "Total Requests", key: "totalRequests", width: 15 },
    { header: "RPS (mean)", key: "rpsMean", width: 12 },
    { header: "RPS (min)", key: "rpsMin", width: 11 },
    { header: "RPS (max)", key: "rpsMax", width: 11 },
    { header: "Latency mean (ms)", key: "latencyMean", width: 17 },
    { header: "Latency min (ms)", key: "latencyMin", width: 16 },
    { header: "Latency max (ms)", key: "latencyMax", width: 16 },
    { header: "p50 (ms)", key: "latencyP50", width: 10 },
    { header: "p90 (ms)", key: "latencyP90", width: 10 },
    { header: "p99 (ms)", key: "latencyP99", width: 10 },
    { header: "Throughput (KB/s)", key: "throughputKBs", width: 17 },
    { header: "Errors", key: "errors", width: 9 },
    { header: "Timeouts", key: "timeouts", width: 10 },
    { header: "Non-2xx", key: "non2xx", width: 10 },
    { header: "Notes", key: "description", width: 66 },
  ];
  styleHeader(perf.getRow(1));
  for (const s of scenarios) {
    const row = perf.addRow(s);
    row.alignment = { vertical: "top", wrapText: true };
  }

  // ── Sheet 3: Test Details ────────────────────────────────────────────────
  const details = wb.addWorksheet("Test Details", { views: [{ state: "frozen", ySplit: 1 }] });
  details.columns = [
    { header: "Test ID", key: "id", width: 22 },
    { header: "Scenario", key: "scenario", width: 30 },
    { header: "Endpoint", key: "endpoint", width: 28 },
    { header: "Metric Under Test", key: "metric", width: 40 },
    { header: "Expected (SLO)", key: "expected", width: 44 },
    { header: "Actual (measured)", key: "actual", width: 34 },
    { header: "Status", key: "status", width: 10 },
    { header: "Notes", key: "error", width: 46 },
  ];
  styleHeader(details.getRow(1));
  for (const c of cases) {
    const row = details.addRow(c);
    row.alignment = { vertical: "top", wrapText: true };
    const cell = row.getCell("status");
    cell.fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: c.status === "PASS" ? BRAND.pass : BRAND.fail },
    };
    cell.font = { bold: true };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  }
  details.autoFilter = { from: "A1", to: "H1" };

  // ── Sheet 4: Throughput Timeline ─────────────────────────────────────────
  const timeline = wb.addWorksheet("Throughput Timeline", { views: [{ state: "frozen", ySplit: 1 }] });
  timeline.columns = [
    { header: "Scenario", key: "scenario", width: 32 },
    { header: "Second", key: "second", width: 10 },
    { header: "Requests in window", key: "requests", width: 20 },
  ];
  styleHeader(timeline.getRow(1));
  for (const s of scenarios) {
    for (const sample of s.samples || []) {
      timeline.addRow({ scenario: s.name, second: sample.second, requests: sample.requests });
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await wb.xlsx.writeFile(outFile);
  return { total, passed, failed, passRate };
}

module.exports = { writeReport };
