"use strict";
/**
 * Excel writers for the security assessment.
 *
 * findings.xlsx carries the four sheets the brief asks for:
 *   1. Security Findings
 *   2. Endpoint Inventory
 *   3. Dependency Vulnerabilities
 *   4. Risk Summary
 *
 * endpoint-inventory.xlsx is the standalone API inventory, plus the Phase 1
 * backend inventory on its own sheet.
 */

const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const SEV_FILL = {
  CRITICAL: "FF7F1D1D",
  HIGH: "FFB91C1C",
  MEDIUM: "FFD97706",
  LOW: "FF65A30D",
  critical: "FF7F1D1D",
  high: "FFB91C1C",
  moderate: "FFD97706",
  low: "FF65A30D",
};

const HEADER = "FF1B5E20";
const WHITE = "FFFFFFFF";

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin" }, left: { style: "thin" },
      bottom: { style: "thin" }, right: { style: "thin" },
    };
  });
  row.height = 28;
}

function severityCell(cell, severity) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SEV_FILL[severity] || "FF9CA3AF" } };
  cell.font = { bold: true, color: { argb: WHITE } };
  cell.alignment = { vertical: "middle", horizontal: "center" };
}

// ── Sheet builders ──────────────────────────────────────────────────────────

function addFindingsSheet(wb, findings) {
  const ws = wb.addWorksheet("Security Findings", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Finding ID", key: "id", width: 14 },
    { header: "Severity", key: "severity", width: 11 },
    { header: "Status", key: "verifyStatus", width: 13 },
    { header: "Vulnerability Type", key: "type", width: 34 },
    { header: "CWE", key: "cwe", width: 40 },
    { header: "OWASP Top 10", key: "owasp", width: 40 },
    { header: "Title", key: "title", width: 60 },
    { header: "File Path", key: "file", width: 46 },
    { header: "Endpoint", key: "endpoint", width: 34 },
    { header: "Description", key: "description", width: 80 },
    { header: "Exploitation Scenario", key: "exploitation", width: 80 },
    { header: "Impact", key: "impact", width: 70 },
    { header: "Recommended Fix", key: "fix", width: 80 },
    { header: "Evidence (scan time)", key: "evidence", width: 60 },
  ];
  styleHeader(ws.getRow(1));

  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const sorted = [...findings].sort(
    (a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id)
  );

  for (const f of sorted) {
    const row = ws.addRow(f);
    row.alignment = { vertical: "top", wrapText: true };
    severityCell(row.getCell("severity"), f.severity);
    const st = row.getCell("verifyStatus");
    st.fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: f.verifyStatus === "CONFIRMED" ? "FFFEE2E2" : "FFD1FAE5" },
    };
    st.font = { bold: true };
    st.alignment = { vertical: "middle", horizontal: "center" };
  }
  ws.autoFilter = { from: "A1", to: "N1" };
  return ws;
}

function addEndpointSheet(wb, endpoints) {
  const ws = wb.addWorksheet("Endpoint Inventory", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Endpoint", key: "endpoint", width: 42 },
    { header: "HTTP Method", key: "method", width: 13 },
    { header: "Authentication Required", key: "auth", width: 28 },
    { header: "Expected Roles", key: "roles", width: 34 },
    { header: "Rate Limited", key: "rateLimited", width: 13 },
    { header: "Controller / File Path", key: "file", width: 44 },
    { header: "Security Notes", key: "notes", width: 66 },
  ];
  styleHeader(ws.getRow(1));

  for (const e of endpoints) {
    const row = ws.addRow(e);
    row.alignment = { vertical: "top", wrapText: true };
    const a = row.getCell("auth");
    a.fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: e.auth === "No" ? "FFFEE2E2" : e.auth.startsWith("Yes") ? "FFD1FAE5" : "FFFEF3C7" },
    };
    a.alignment = { vertical: "middle", horizontal: "center" };
    const rl = row.getCell("rateLimited");
    rl.fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: e.rateLimited === "Yes" ? "FFD1FAE5" : "FFFEE2E2" },
    };
    rl.alignment = { vertical: "middle", horizontal: "center" };
  }
  ws.autoFilter = { from: "A1", to: "G1" };
  return ws;
}

function addDependencySheet(wb, deps) {
  const ws = wb.addWorksheet("Dependency Vulnerabilities", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Severity", key: "severity", width: 12 },
    { header: "Package", key: "package", width: 26 },
    { header: "Vulnerable Versions", key: "vulnerable", width: 26 },
    { header: "Patched In", key: "patched", width: 22 },
    { header: "CVE / Advisory", key: "cve", width: 24 },
    { header: "Title", key: "title", width: 88 },
    { header: "Reachability", key: "reach", width: 24 },
    { header: "Advisory URL", key: "url", width: 50 },
  ];
  styleHeader(ws.getRow(1));

  // Which packages sit in the backend request path vs the build toolchain.
  const RUNTIME = new Set([
    "@grpc/grpc-js", "protobufjs", "ws", "form-data", "undici", "axios",
    "qs", "body-parser", "express", "firebase-admin", "fast-xml-builder",
    "ip-address", "uuid", "@tootallnate/once",
  ]);

  if (deps.skipped) {
    ws.addRow({ severity: "-", package: "-", title: "Dependency scan skipped (--no-audit)" });
    return ws;
  }

  for (const a of deps.advisories) {
    const row = ws.addRow({ ...a, reach: RUNTIME.has(a.package) ? "Backend runtime" : "Build / dev only" });
    row.alignment = { vertical: "top", wrapText: true };
    severityCell(row.getCell("severity"), a.severity);
    const r = row.getCell("reach");
    r.fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: RUNTIME.has(a.package) ? "FFFEE2E2" : "FFF3F4F6" },
    };
  }
  ws.autoFilter = { from: "A1", to: "H1" };
  return ws;
}

function addRiskSummarySheet(wb, { inventory, endpoints, findings, secrets, deps, score, grade }) {
  const ws = wb.addWorksheet("Risk Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Metric", key: "metric", width: 46 },
    { header: "Value", key: "value", width: 78 },
  ];
  styleHeader(ws.getRow(1));

  const confirmed = findings.filter((f) => f.verifyStatus === "CONFIRMED");
  const bySev = (s) => confirmed.filter((f) => f.severity === s).length;

  const section = (label) => {
    const r = ws.addRow({ metric: label, value: "" });
    styleHeader(r);
  };

  section("ASSESSMENT");
  [
    ["Application", "MediGuard — medication management platform"],
    ["Assessment date", new Date().toISOString()],
    ["Scope", "apps/backend, apps/web, apps/mobile, firestore.rules, dependency tree"],
    ["Method", "SAST with per-finding re-verification + secret scan + local DAST + dependency audit"],
  ].forEach((r) => ws.addRow({ metric: r[0], value: r[1] }));

  ws.addRow({ metric: "", value: "" });
  section("OVERALL SECURITY SCORE");
  const scoreRow = ws.addRow({ metric: "Score", value: `${score} / 100` });
  scoreRow.getCell("value").font = { bold: true, size: 16 };
  scoreRow.getCell("value").fill = {
    type: "pattern", pattern: "solid",
    fgColor: { argb: score >= 75 ? "FFD1FAE5" : score >= 50 ? "FFFEF3C7" : "FFFEE2E2" },
  };
  scoreRow.height = 28;
  ws.addRow({ metric: "Grade", value: grade });

  ws.addRow({ metric: "", value: "" });
  section("FINDINGS BY SEVERITY");
  [
    ["Critical", bySev("CRITICAL")],
    ["High", bySev("HIGH")],
    ["Medium", bySev("MEDIUM")],
    ["Low", bySev("LOW")],
    ["Total confirmed", confirmed.length],
    ["Remediated (retained for history)", findings.length - confirmed.length],
  ].forEach(([k, v]) => {
    const row = ws.addRow({ metric: k, value: v });
    if (SEV_FILL[k.toUpperCase()]) severityCell(row.getCell("metric"), k.toUpperCase());
  });

  ws.addRow({ metric: "", value: "" });
  section("ATTACK SURFACE");
  const unauth = endpoints.filter((e) => e.auth === "No");
  [
    ["Total endpoints discovered", endpoints.length],
    ["Requiring a Firebase ID token", endpoints.filter((e) => e.auth.startsWith("Yes")).length],
    ["Requiring a shared secret", endpoints.filter((e) => e.auth.startsWith("Shared")).length],
    ["Requiring NO authentication", `${unauth.length}  (${unauth.map((e) => e.method + " " + e.endpoint).join(", ")})`],
    ["Rate limited", endpoints.filter((e) => e.rateLimited === "Yes").length],
    ["NOT rate limited", endpoints.filter((e) => e.rateLimited === "No").length],
  ].forEach(([k, v]) => ws.addRow({ metric: k, value: String(v) }));

  ws.addRow({ metric: "", value: "" });
  section("DEPENDENCY POSTURE");
  [
    ["Critical advisories", deps.counts.critical || 0],
    ["High advisories", deps.counts.high || 0],
    ["Moderate advisories", deps.counts.moderate || 0],
    ["Low advisories", deps.counts.low || 0],
    ["Total advisories", (deps.advisories || []).length],
  ].forEach(([k, v]) => ws.addRow({ metric: k, value: String(v) }));

  ws.addRow({ metric: "", value: "" });
  section("SECRET SCAN");
  ws.addRow({ metric: "Pattern matches in tracked files", value: String(secrets.length) });
  ws.addRow({
    metric: "Note",
    value: "Firebase client API keys are identifiers, not secrets. Tracked as MG-SEC-017; the fix is key restriction in Cloud Console, not removal from git.",
  }).getCell("value").alignment = { wrapText: true, vertical: "top" };

  ws.addRow({ metric: "", value: "" });
  section("TOP 3 RISKS");
  const order = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  [...confirmed].sort((a, b) => order[b.severity] - order[a.severity]).slice(0, 3)
    .forEach((f, i) => {
      const row = ws.addRow({ metric: `${i + 1}. ${f.id} (${f.severity})`, value: f.title });
      row.getCell("value").alignment = { wrapText: true, vertical: "top" };
      severityCell(row.getCell("metric"), f.severity);
    });

  ws.addRow({ metric: "", value: "" });
  section("BACKEND INVENTORY");
  Object.entries(inventory).forEach(([k, v]) => {
    const row = ws.addRow({ metric: k, value: String(v) });
    row.getCell("value").alignment = { wrapText: true, vertical: "top" };
  });

  return ws;
}

// ── Public writers ──────────────────────────────────────────────────────────

async function writeFindingsWorkbook(opts) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MediGuard security assessment";
  wb.created = new Date();

  addFindingsSheet(wb, opts.findings);
  addEndpointSheet(wb, opts.endpoints);
  addDependencySheet(wb, opts.deps);
  addRiskSummarySheet(wb, opts);

  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  await wb.xlsx.writeFile(opts.outFile);
}

async function writeEndpointWorkbook(opts) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MediGuard security assessment";
  wb.created = new Date();

  addEndpointSheet(wb, opts.endpoints);

  const ws = wb.addWorksheet("Backend Inventory", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Property", key: "metric", width: 30 },
    { header: "Detected Value", key: "value", width: 110 },
  ];
  styleHeader(ws.getRow(1));
  Object.entries(opts.inventory).forEach(([k, v]) => {
    const row = ws.addRow({ metric: k, value: String(v) });
    row.getCell("value").alignment = { wrapText: true, vertical: "top" };
  });

  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  await wb.xlsx.writeFile(opts.outFile);
}

module.exports = { writeFindingsWorkbook, writeEndpointWorkbook };
