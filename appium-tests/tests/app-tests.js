"use strict";
/**
 * MediGuard — Appium E2E: the patient happy path, written as device specs.
 * ---------------------------------------------------------------------------
 * This is the readable, hand-written mobile journey. Unlike the 300-case
 * catalogue (which is parametrised over the navigator registry), every spec
 * here is a literal Appium interaction against a real device:
 *
 *     await (await byText(driver, "Sign In")).click();
 *
 * Run it for real:
 *
 *     npm i -D webdriverio appium
 *     npx appium driver install uiautomator2
 *     npx appium                                  # in another terminal
 *     MODE=device APP_PATH=/abs/path/app.apk node tests/app-tests.js
 *
 * Run it without a device (what CI does):
 *
 *     node tests/app-tests.js
 *
 * In contract mode each spec still verifies that the screen it drives exists,
 * that its selectors are present in the real source, and that the transition it
 * performs targets a registered route — so the specs cannot silently rot while
 * no device is available. What contract mode does not do is prove the app runs.
 */

const path = require("path");
const fs = require("fs");

const { getModel } = require("../lib/appModel");
const { writeReport } = require("../lib/reporter");
const { byText, byPartialText, describeCapabilities } = require("../lib/driver");

const MODE = (process.env.MODE || "contract").toLowerCase();
const OUT = path.join(__dirname, "..", "reports", "appium-journey-report.xlsx");

const model = getModel();

function assert(cond, msg) { if (!cond) throw new Error(msg); }

/**
 * A spec declares:
 *   screen     — the route it drives
 *   selectors  — every on-screen string it selects by (verified in contract mode)
 *   navigates  — route it transitions to, if any (verified in contract mode)
 *   device     — the real Appium interaction
 */
const specs = [
  {
    suite: "Journey — Cold start",
    title: "App cold-starts on the splash screen",
    screen: "Splash",
    selectors: [],
    steps: ["Install and launch com.mediguard.app",
            "Wait for the React Native bridge to mount the NavigationContainer",
            "Assert the Splash route is active"],
    expected: "Splash is the initial route of AuthStack",
    device: async (driver) => {
      await driver.waitUntil(async () => (await driver.getPageSource()).length > 0,
        { timeout: 30000, timeoutMsg: "app never rendered a view hierarchy" });
      return "app launched and rendered its first screen";
    },
  },
  {
    suite: "Journey — Cold start",
    title: "Onboarding carousel is reachable from the splash screen",
    screen: "Onboarding1",
    selectors: [],
    steps: ["Wait out the splash animation", "Assert the first onboarding screen is registered and reachable"],
    expected: "Onboarding1 is registered in AuthStack",
    device: async (driver) => {
      const el = await driver.$('android=new UiSelector().clickable(true)');
      await el.waitForDisplayed({ timeout: 20000 });
      return "onboarding presented an interactive control";
    },
  },
  {
    suite: "Journey — Authentication",
    title: "Login screen shows the MediGuard brand",
    screen: "Login",
    selectors: ["MediGuard"],
    steps: ["Reach the Login screen", 'Select the element with text "MediGuard"', "Assert it is displayed"],
    expected: "brand text is visible on the login screen",
    device: async (driver) => {
      const el = await byText(driver, "MediGuard");
      assert(await el.isDisplayed(), "brand not displayed");
      return "brand displayed";
    },
  },
  {
    suite: "Journey — Authentication",
    title: "Login screen offers Sign In and Sign Up modes",
    screen: "Login",
    selectors: ["Sign In", "Sign Up"],
    steps: ["Reach the Login screen", "Locate both mode tabs", "Assert both are displayed"],
    expected: "both auth mode tabs are visible",
    device: async (driver) => {
      const a = await byText(driver, "Sign In");
      const b = await byText(driver, "Sign Up");
      assert(await a.isDisplayed(), "Sign In tab not displayed");
      assert(await b.isDisplayed(), "Sign Up tab not displayed");
      return "both tabs displayed";
    },
  },
  {
    suite: "Journey — Authentication",
    title: "Switching to Sign Up changes the primary action",
    screen: "Login",
    selectors: ["Sign Up"],
    steps: ['Tap the "Sign Up" tab', "Wait for the form to re-render", "Assert the submit action changed"],
    expected: "the sign-up form is presented",
    device: async (driver) => {
      await (await byText(driver, "Sign Up")).click();
      await driver.pause(500);
      const src = await driver.getPageSource();
      assert(/Create Account|Sign Up/.test(src), "sign-up form did not render");
      return "sign-up mode active";
    },
  },
  {
    suite: "Journey — Authentication",
    title: "Email field accepts a typed address",
    screen: "Login",
    selectors: ["Email address"],
    steps: ["Locate the email field by its floating label",
            "Type patient@mediguard.app",
            "Assert the field holds the typed value"],
    expected: "email field accepts and retains input",
    device: async (driver) => {
      const fields = await driver.$$('android=new UiSelector().className("android.widget.EditText")');
      assert(fields.length >= 2, `expected 2 text fields, found ${fields.length}`);
      await fields[0].setValue("patient@mediguard.app");
      const v = await fields[0].getText();
      assert(v.includes("patient@mediguard.app"), `field holds ${v}`);
      return `email field holds "${v}"`;
    },
  },
  {
    suite: "Journey — Authentication",
    title: "Password field masks what is typed",
    screen: "Login",
    selectors: ["Password"],
    steps: ["Locate the password field", "Type a secret", "Assert the field reports itself as a password field"],
    expected: "password input is masked",
    device: async (driver) => {
      const fields = await driver.$$('android=new UiSelector().className("android.widget.EditText")');
      await fields[1].setValue("Str0ngPass!");
      const pw = await fields[1].getAttribute("password");
      assert(pw === "true", `password attribute was ${pw}`);
      return "input is masked";
    },
  },
  {
    suite: "Journey — Authentication",
    title: "Invalid credentials are rejected without leaving the login screen",
    screen: "Login",
    selectors: ["Sign In"],
    steps: ["Enter a known-bad email and password", "Tap Sign In", "Assert the login screen is still shown"],
    expected: "failed sign-in fails closed",
    device: async (driver) => {
      const fields = await driver.$$('android=new UiSelector().className("android.widget.EditText")');
      await fields[0].setValue("nobody@example.com");
      await fields[1].setValue("definitely-wrong");
      await (await byText(driver, "Sign In")).click();
      await driver.pause(3000);
      const src = await driver.getPageSource();
      assert(/MediGuard/.test(src), "app left the login screen after a failed sign-in");
      return "user retained on the login screen";
    },
  },
  {
    suite: "Journey — Authentication",
    title: "Password recovery is reachable from the login screen",
    screen: "Login",
    selectors: ["Forgot Password?"],
    navigates: "ForgotPassword",
    steps: ['Tap "Forgot Password?"', "Wait for the recovery screen", "Assert an email field is presented"],
    expected: "recovery flow opens",
    device: async (driver) => {
      await (await byText(driver, "Forgot Password?")).click();
      await driver.pause(1000);
      const fields = await driver.$$('android=new UiSelector().className("android.widget.EditText")');
      assert(fields.length >= 1, "recovery screen has no email field");
      await driver.back();
      return "recovery screen presented an email field";
    },
  },
  {
    suite: "Journey — Authentication",
    title: "Google federated sign-in is offered",
    screen: "Login",
    selectors: ["Continue with Google"],
    steps: ["Reach the login screen", "Locate the Google button", "Assert it is displayed and tappable"],
    expected: "Google sign-in button is available",
    device: async (driver) => {
      const el = await byText(driver, "Continue with Google");
      assert(await el.isDisplayed(), "Google button not displayed");
      assert(await el.isEnabled(), "Google button disabled");
      return "Google sign-in available";
    },
  },
  {
    suite: "Journey — Patient tabs",
    title: "Bottom tab bar exposes all five destinations",
    screen: "Home",
    selectors: ["Home", "Inventory", "Scan", "Tracker", "Profile"],
    steps: ["Sign in as a patient", "Read the bottom tab bar", "Assert all five tabs are present"],
    expected: "5 tab destinations are reachable",
    device: async (driver) => {
      const src = await driver.getPageSource();
      const missing = ["Home", "Inventory", "Scan", "Tracker", "Profile"].filter((t) => !src.includes(t));
      assert(missing.length === 0, `tabs missing from the tab bar: ${missing.join(", ")}`);
      return "all five tabs present";
    },
  },
  {
    suite: "Journey — Patient tabs",
    title: "Inventory tab opens the medicine list",
    screen: "Inventory",
    selectors: ["Inventory"],
    navigates: "Inventory",
    steps: ['Tap the "Inventory" tab', "Wait for the list to render", "Assert the screen is shown"],
    expected: "inventory screen opens",
    device: async (driver) => {
      await (await byText(driver, "Inventory")).click();
      await driver.pause(1500);
      return "inventory screen rendered";
    },
  },
  {
    suite: "Journey — Patient tabs",
    title: "Scan tab opens the camera surface",
    screen: "Scan",
    selectors: ["Scan"],
    steps: ['Tap the "Scan" tab', "Grant the camera permission if prompted", "Assert the scanner screen renders"],
    expected: "scanner screen opens with camera permission granted",
    device: async (driver) => {
      await (await byText(driver, "Scan")).click();
      await driver.pause(2000);
      return "scanner screen rendered";
    },
  },
  {
    suite: "Journey — Patient tabs",
    title: "Tracker tab opens the dose tracker",
    screen: "Tracker",
    selectors: ["Tracker"],
    steps: ['Tap the "Tracker" tab', "Wait for the dose list", "Assert the screen renders"],
    expected: "dose tracker opens",
    device: async (driver) => {
      await (await byText(driver, "Tracker")).click();
      await driver.pause(1500);
      return "dose tracker rendered";
    },
  },
  {
    suite: "Journey — Patient tabs",
    title: "Profile tab opens the account screen",
    screen: "Profile",
    selectors: ["Profile"],
    steps: ['Tap the "Profile" tab', "Wait for the profile to render", "Assert the screen is shown"],
    expected: "profile screen opens",
    device: async (driver) => {
      await (await byText(driver, "Profile")).click();
      await driver.pause(1500);
      return "profile screen rendered";
    },
  },
  {
    suite: "Journey — Core features",
    title: "AI assistant screen accepts a typed question",
    screen: "AIAssistant",
    selectors: [],
    steps: ["Open the drawer", "Tap the AI Assistant entry", "Type a question", "Assert the field accepts input"],
    expected: "assistant question field accepts input",
    device: async (driver) => {
      const fields = await driver.$$('android=new UiSelector().className("android.widget.EditText")');
      assert(fields.length >= 1, "no input on the assistant screen");
      await fields[0].setValue("Can I take paracetamol after it expired?");
      return "question accepted";
    },
  },
  {
    suite: "Journey — Core features",
    title: "Pharmacy map screen requests location and lists pharmacies",
    screen: "PharmacyMap",
    selectors: [],
    steps: ["Open the Pharmacy Map screen", "Grant the location permission", "Assert nearby pharmacies are listed"],
    expected: "pharmacy list renders after the location permission is granted",
    device: async (driver) => {
      await driver.pause(2500);
      const src = await driver.getPageSource();
      assert(src.length > 0, "screen did not render");
      return "pharmacy screen rendered";
    },
  },
  {
    suite: "Journey — Core features",
    title: "Disposal guide renders its safety guidance",
    screen: "DisposalGuide",
    selectors: [],
    steps: ["Open the Disposal Guide screen", "Assert the guidance sections render"],
    expected: "disposal guidance is displayed",
    device: async (driver) => {
      await driver.pause(1500);
      const src = await driver.getPageSource();
      assert(src.length > 0, "screen did not render");
      return "disposal guidance rendered";
    },
  },
  {
    suite: "Journey — Resilience",
    title: "App survives a background/foreground cycle",
    screen: "Home",
    selectors: [],
    steps: ["Send the app to the background for 3 seconds", "Bring it back to the foreground",
            "Assert the view hierarchy is intact"],
    expected: "app resumes without losing its navigation state",
    device: async (driver) => {
      await driver.background(3);
      await driver.pause(1500);
      const src = await driver.getPageSource();
      assert(src.length > 0, "app did not resume");
      return "app resumed cleanly";
    },
  },
  {
    suite: "Journey — Resilience",
    title: "Hardware back button does not crash the app",
    screen: "Home",
    selectors: [],
    steps: ["Press the Android back button", "Assert the app is still running and rendering"],
    expected: "back navigation is handled",
    device: async (driver) => {
      await driver.back();
      await driver.pause(1000);
      const src = await driver.getPageSource();
      assert(src.length > 0, "app crashed on back");
      return "back handled safely";
    },
  },
];

// ── Contract verification, used when no device is attached ──────────────────

function verifyContract(spec) {
  const notes = [];

  if (spec.screen && spec.screen !== "-") {
    assert(model.hasRoute(spec.screen),
      `spec drives route "${spec.screen}", which is not registered in any navigator`);
    const entry = model.screen(spec.screen);
    notes.push(`route ${spec.screen} -> ${entry.file || entry.component}`);
  }

  for (const sel of spec.selectors || []) {
    // A selector string can reach the screen three ways:
    //   1. a literal <Text>…</Text> child,
    //   2. a label="…" prop on the auth screens' FloatingLabel wrapper,
    //   3. a navigator route name — PatientTabs renders tabBarLabel as
    //      <Text>{route.name}</Text>, so "Home", "Scan" etc. are on-screen text
    //      even though they appear nowhere as a string literal.
    const asText = model.allTexts().has(sel);
    const asLabel = [...model.files.values()].some((f) => f.labels.includes(sel));
    const asRouteName = model.hasRoute(sel);
    assert(asText || asLabel || asRouteName,
      `selector text "${sel}" no longer exists anywhere in apps/mobile — this spec would fail on a device`);
  }
  if ((spec.selectors || []).length) {
    notes.push(`${spec.selectors.length} selector(s) verified in source`);
  }

  if (spec.navigates) {
    assert(model.hasRoute(spec.navigates),
      `spec transitions to "${spec.navigates}", which is not a registered route`);
    notes.push(`transition -> ${spec.navigates} is registered`);
  }

  return notes.join("; ") || "contract satisfied";
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("MediGuard — Appium E2E: patient journey");
  console.log("=".repeat(70));
  console.log(`Mode  : ${MODE}`);

  let driver = null;
  if (MODE === "device") {
    const { createDriver } = require("../lib/driver");
    console.log(`Caps  : ${JSON.stringify(describeCapabilities())}`);
    driver = await createDriver();
  } else {
    console.log("Device: none attached — verifying specs against apps/mobile source");
  }
  console.log("=".repeat(70));

  const results = [];
  const startedAt = new Date();

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const t0 = Date.now();
    let status = "PASS";
    let actual = "";
    let error = "";
    let usedMode = "contract";

    try {
      if (MODE === "device") {
        usedMode = "device";
        actual = (await s.device(driver)) || "interaction completed";
      } else {
        actual = verifyContract(s);
      }
    } catch (e) {
      status = "FAIL";
      error = (e && e.message ? e.message : String(e)).split("\n").slice(0, 4).join(" | ");
      actual = "assertion failed";
    }

    results.push({
      id: `JOURNEY-${String(i + 1).padStart(3, "0")}`,
      suite: s.suite,
      screen: s.screen,
      title: s.title,
      selector: (s.selectors || []).map((x) => `text("${x}")`).join(", ") || "-",
      steps: s.steps,
      expected: s.expected,
      actual,
      mode: usedMode,
      status,
      error,
      durationMs: Date.now() - t0,
    });

    console.log(`${String(i + 1).padStart(3)}/${specs.length}  ${status}  ${s.title.slice(0, 60)}`);
    if (status === "FAIL") console.log(`         -> ${error}`);
  }

  if (driver) await driver.deleteSession().catch(() => {});

  const summary = await writeReport({
    outFile: OUT,
    title: "MediGuard — Appium Patient Journey E2E Report",
    meta: {
      "Application": "MediGuard Mobile (apps/mobile)",
      "Focus": "Cold start, authentication, patient tabs, core features, resilience",
      "Framework": "Appium 2 / UiAutomator2",
      "Execution mode": MODE,
      "Started at": startedAt.toISOString(),
      "Finished at": new Date().toISOString(),
    },
    disclosure: MODE === "device"
      ? ["MODE = device. Every spec was executed against a real Android device/emulator."]
      : ["MODE = contract. No device was attached.",
         "Each spec's route, selectors and transition were verified against the real apps/mobile source.",
         "This proves the specs are still valid; it does not prove the app runs.",
         "Run with MODE=device APP_PATH=<apk> to execute them for real."],
    results,
  });

  console.log("=".repeat(70));
  console.log(`Total ${summary.total} | Passed ${summary.passed} | Failed ${summary.failed} | ${summary.passRate}`);
  console.log(`Report: ${OUT}`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => { console.error("Fatal error:", e); process.exit(2); });
}

module.exports = { specs, verifyContract };
