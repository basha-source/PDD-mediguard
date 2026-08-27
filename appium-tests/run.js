"use strict";
/**
 * MediGuard — Appium E2E runner.
 *
 *   node run.js                                   # contract mode (CI default)
 *   MODE=device APP_PATH=./MediGuard.apk node run.js
 *   node run.js --filter="Navigation Graph"
 *
 * Exit code 1 on any failure.
 */

const path = require("path");
const fs = require("fs");

const { cases, model } = require("./lib/catalog");
const { writeReport } = require("./lib/reporter");
const { describeCapabilities } = require("./lib/driver");

const MODE = (process.env.MODE || "contract").toLowerCase();
const OUT = path.join(__dirname, "reports", "appium-test-report.xlsx");
const JSON_OUT = path.join(__dirname, "reports", "appium-results.json");

const args = process.argv.slice(2);
const filter = (args.find((a) => a.startsWith("--filter=")) || "").split("=")[1] || "";

const DISCLOSURE_CONTRACT = [
  "MODE = contract. No Android device or emulator was attached to this run.",
  "Each case verifies its Appium declarations against a model parsed from the real apps/mobile source:",
  "  - the route it drives is registered in a navigator,",
  "  - the component resolves to a real screen file that exports it,",
  "  - the text its UiAutomator2 selector targets still exists in that screen,",
  "  - and every navigate() target in the app is a registered route.",
  "This catches deleted screens, renamed routes, dead navigation links and reworded selectors.",
  "It does NOT prove the app renders, responds to taps, or works on a device.",
  "For that, run: MODE=device APP_PATH=<path to APK> node run.js  (needs Appium 2 + UiAutomator2 + a device).",
];

const DISCLOSURE_DEVICE = [
  "MODE = device. Cases were executed against a real Android device/emulator through Appium.",
  "Cases without a device implementation fall back to contract verification and are marked accordingly.",
];

function bar(done, total, width = 28) {
  const filled = Math.round((done / total) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

async function main() {
  const selected = filter
    ? cases.filter((c) => c.suite.includes(filter) || c.title.includes(filter))
    : cases;

  console.log("MediGuard — Appium mobile E2E functional suite");
  console.log("=".repeat(70));
  console.log(`Mode             : ${MODE}`);
  console.log(`App source       : ${model.root}`);
  console.log(`Routes discovered: ${model.registry.size}`);
  console.log(`Cases to execute : ${selected.length}${filter ? ` (filter: ${filter})` : ""}`);

  let driver = null;
  if (MODE === "device") {
    const { createDriver } = require("./lib/driver");
    console.log(`Capabilities     : ${JSON.stringify(describeCapabilities())}`);
    driver = await createDriver();
    console.log("Session          : established");
  } else {
    console.log("Device           : none attached — running source-contract verification");
  }
  console.log("=".repeat(70));

  const results = [];
  const startedAt = new Date();

  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const t0 = Date.now();
    let status = "PASS";
    let actual = "";
    let error = "";
    let usedMode = "contract";

    try {
      if (MODE === "device" && c.device) {
        usedMode = "device";
        actual = (await c.device(driver)) || "interaction completed";
      } else {
        actual = (await c.contract(model)) || "contract satisfied";
      }
    } catch (e) {
      status = "FAIL";
      error = (e && e.message ? e.message : String(e)).split("\n").slice(0, 4).join(" | ");
      actual = "assertion failed";
    }

    results.push({
      id: c.id,
      suite: c.suite,
      screen: c.screen,
      title: c.title,
      selector: c.selector,
      steps: c.steps,
      expected: c.expected,
      actual,
      mode: usedMode,
      status,
      error,
      durationMs: Date.now() - t0,
    });

    console.log(`${bar(i + 1, selected.length)} ${String(i + 1).padStart(3)}/${selected.length}  ${status}  ${c.id}  ${c.title.slice(0, 56)}`);
    if (status === "FAIL") console.log(`      -> ${error}`);
  }

  if (driver) await driver.deleteSession().catch(() => {});

  const finishedAt = new Date();
  const deviceCases = results.filter((r) => r.mode === "device").length;

  const summary = await writeReport({
    outFile: OUT,
    title: "MediGuard — Appium Mobile E2E Functional Test Report",
    meta: {
      "Application": "MediGuard Mobile (apps/mobile)",
      "Platform": "Android / React Native " + (model.pkg.dependencies["react-native"] || "?"),
      "App package": (model.app.expo && model.app.expo.android && model.app.expo.android.package) || "-",
      "App version": (model.app.expo && model.app.expo.version) || "-",
      "Test type": "Functional End-to-End (mobile UI automation)",
      "Framework": "Appium 2 / UiAutomator2 (WebdriverIO client)",
      "Execution mode": MODE,
      "Cases run on a device": deviceCases,
      "Cases verified against source": results.length - deviceCases,
      "Routes under test": model.registry.size,
      "Started at": startedAt.toISOString(),
      "Finished at": finishedAt.toISOString(),
      "Wall clock": ((finishedAt - startedAt) / 1000).toFixed(1) + " s",
    },
    disclosure: MODE === "device" ? DISCLOSURE_DEVICE : DISCLOSURE_CONTRACT,
    results,
  });

  fs.writeFileSync(JSON_OUT, JSON.stringify({ mode: MODE, summary, results }, null, 2));

  console.log("=".repeat(70));
  console.log(`Total   : ${summary.total}`);
  console.log(`Passed  : ${summary.passed}`);
  console.log(`Failed  : ${summary.failed}`);
  console.log(`Pass %  : ${summary.passRate}`);
  console.log(`Mode    : ${MODE} (${deviceCases} on device, ${results.length - deviceCases} against source)`);
  console.log(`Report  : ${OUT}`);
  console.log("=".repeat(70));

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error in the Appium runner:", e);
  process.exit(2);
});
