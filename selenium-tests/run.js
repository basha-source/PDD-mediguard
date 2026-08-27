"use strict";
/**
 * MediGuard — Selenium E2E runner.
 *
 * Builds nothing itself: it expects apps/web/dist to exist (the CI job runs the
 * Vite build first) and serves that directory over loopback, then drives a real
 * headless Chrome through all 300 catalogue cases and writes an Excel report.
 *
 *   node run.js                   # full suite, headless
 *   HEADLESS=false node run.js    # watch it run
 *   node run.js --filter=Guard    # only suites matching a substring
 *   node run.js --bail            # stop at the first failure
 *
 * Exit code is 1 if any case failed, so CI fails loudly rather than uploading a
 * green-looking report full of red rows.
 */

const path = require("path");
const fs = require("fs");

const { startServer } = require("./lib/server");
const { createDriver, goto } = require("./lib/browser");
const { cases } = require("./lib/catalog");
const { writeReport } = require("./lib/reporter");

const ROOT = path.resolve(__dirname, "..");
const DIST = process.env.WEB_DIST || path.join(ROOT, "apps", "web", "dist");
const OUT = path.join(__dirname, "reports", "selenium-test-report.xlsx");
const JSON_OUT = path.join(__dirname, "reports", "selenium-results.json");

const args = process.argv.slice(2);
const filter = (args.find((a) => a.startsWith("--filter=")) || "").split("=")[1] || "";
const bail = args.includes("--bail");

function bar(done, total, width = 28) {
  const filled = Math.round((done / total) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

async function main() {
  const selected = filter
    ? cases.filter((c) => c.suite.includes(filter) || c.title.includes(filter))
    : cases;

  console.log("MediGuard — Selenium E2E functional suite");
  console.log("=".repeat(64));
  console.log(`Build under test : ${DIST}`);
  console.log(`Cases to execute : ${selected.length}${filter ? ` (filter: ${filter})` : ""}`);

  if (!fs.existsSync(DIST)) {
    console.error(`\nERROR: no build at ${DIST}`);
    console.error("Run:  pnpm --filter @mediguard/web build");
    process.exit(2);
  }

  const site = await startServer(DIST);
  console.log(`Serving build at : ${site.baseUrl}`);

  const driver = await createDriver();
  const caps = await driver.getCapabilities();
  const browserName = caps.get("browserName");
  const browserVersion = caps.get("browserVersion");
  console.log(`Browser          : ${browserName} ${browserVersion}`);
  console.log("=".repeat(64));

  const ctx = { driver, baseUrl: site.baseUrl, goto };
  const results = [];
  const startedAt = new Date();

  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const t0 = Date.now();
    let status = "PASS";
    let actual = "";
    let error = "";

    try {
      actual = (await c.run(ctx)) || "assertion satisfied";
    } catch (e) {
      status = "FAIL";
      error = (e && e.message ? e.message : String(e)).split("\n").slice(0, 4).join(" | ");
      actual = "assertion failed";
    }

    const durationMs = Date.now() - t0;
    results.push({ ...c, run: undefined, status, actual, error, durationMs });

    const line = `${bar(i + 1, selected.length)} ${String(i + 1).padStart(3)}/${selected.length}  ${status === "PASS" ? "PASS" : "FAIL"}  ${c.id}  ${c.title.slice(0, 58)}`;
    console.log(line);
    if (status === "FAIL") console.log(`      -> ${error}`);
    if (status === "FAIL" && bail) break;
  }

  await driver.quit();
  await site.close();

  const finishedAt = new Date();
  const summary = await writeReport({
    outFile: OUT,
    title: "MediGuard — Selenium Web E2E Functional Test Report",
    meta: {
      "Application": "MediGuard Web (apps/web)",
      "Test type": "Functional End-to-End (UI automation)",
      "Framework": "Selenium WebDriver 4 (Node.js)",
      "Browser": `${browserName} ${browserVersion}`,
      "Execution mode": process.env.HEADLESS === "false" ? "Headed" : "Headless",
      "Base URL": site.baseUrl,
      "Build directory": DIST,
      "Started at": startedAt.toISOString(),
      "Finished at": finishedAt.toISOString(),
      "Wall clock": ((finishedAt - startedAt) / 1000).toFixed(1) + " s",
    },
    results,
  });

  fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, results }, null, 2));

  console.log("=".repeat(64));
  console.log(`Total   : ${summary.total}`);
  console.log(`Passed  : ${summary.passed}`);
  console.log(`Failed  : ${summary.failed}`);
  console.log(`Pass %  : ${summary.passRate}`);
  console.log(`Report  : ${OUT}`);
  console.log("=".repeat(64));

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error in the Selenium runner:", e);
  process.exit(2);
});
