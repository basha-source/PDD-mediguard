"use strict";
/**
 * MediGuard — Selenium E2E: authentication surface.
 * ---------------------------------------------------------------------------
 * This is the focused, readable login/authentication suite. It drives a real
 * headless Chrome against a real production build of apps/web and asserts the
 * behaviour a reviewer most wants to see proven:
 *
 *   1.  the sign-in screen renders and is usable
 *   2.  the sign-in / sign-up modes swap correctly
 *   3.  credentials are handled safely (masking, no leakage to storage)
 *   4.  client-side validation matches the shipped form's real constraints
 *   5.  an anonymous visitor cannot reach a single protected route
 *   6.  a failed sign-in fails closed, without leaking internals
 *
 * The full 300-case catalogue lives in ../lib/catalog.js and is executed by
 * ../run.js. This file is standalone and self-reporting:
 *
 *     node tests/login-tests.js
 *
 * Prerequisite — build the web app once so there is something to serve:
 *
 *     pnpm --filter @mediguard/web build
 *
 * Why not Mocha/Jest? The suite has to produce an Excel report as its primary
 * artefact and run identically on Windows and on a CI runner. A plain runner
 * with an explicit result array is fewer moving parts than a framework plus a
 * custom reporter plugin, and it keeps the assertion output in one place.
 */

const path = require("path");
const fs = require("fs");
const { By, Key, until } = require("selenium-webdriver");

const { startServer } = require("../lib/server");
const { createDriver, goto } = require("../lib/browser");
const { writeReport } = require("../lib/reporter");
const {
  PROTECTED_ROUTES,
  VALID_EMAILS,
  INVALID_EMAILS,
} = require("../lib/catalog");

const ROOT = path.resolve(__dirname, "..", "..");
const DIST = process.env.WEB_DIST || path.join(ROOT, "apps", "web", "dist");
const OUT = path.join(__dirname, "..", "reports", "selenium-login-report.xlsx");

// ── Tiny assertion kit ──────────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertMatch(value, regex, label) {
  if (!regex.test(String(value))) {
    throw new Error(`${label}: ${JSON.stringify(String(value).slice(0, 120))} did not match ${regex}`);
  }
}

// ── Page object for the login screen ────────────────────────────────────────
// Selectors are anchored on semantics the app actually commits to (input types,
// button text, the <form> element) rather than on Tailwind utility classes,
// which change every time someone restyles the card.

class LoginPage {
  constructor(driver, baseUrl) {
    this.driver = driver;
    this.baseUrl = baseUrl;
  }

  async open() {
    await goto(this.driver, this.baseUrl, "/login");
    return this;
  }

  emailField() {
    return this.driver.findElement(By.css("input[type=email]"));
  }

  /** The password input, whether or not "Show" has flipped it to type=text. */
  passwordField() {
    return this.driver.findElement(By.css("form input:nth-of-type(1) ~ *, form input"))
      .then(() => this.driver.executeScript(
        "return document.querySelectorAll('form input')[1];"));
  }

  submitButton() {
    return this.driver.findElement(By.css("form button[type=submit]"));
  }

  tab(name) {
    return this.driver.findElement(By.xpath(`//button[normalize-space()='${name}']`));
  }

  googleButton() {
    return this.driver.findElement(By.xpath("//button[contains(.,'Continue with Google')]"));
  }

  forgotPasswordLink() {
    return this.driver.findElement(By.xpath("//button[contains(.,'Forgot password')]"));
  }

  async passwordType() {
    return this.driver.executeScript("return document.querySelectorAll('form input')[1].type;");
  }

  async submitLabel() {
    return this.driver.executeScript(
      "return document.querySelector('form button[type=submit]').innerText.trim();");
  }

  async errorText() {
    return this.driver.executeScript(`
      var el = document.querySelector('.text-alert-red');
      return el ? el.innerText.trim() : '';`);
  }

  async path() {
    return this.driver.executeScript("return window.location.pathname;");
  }

  async signIn(email, password) {
    const e = await this.emailField();
    await e.clear();
    await e.sendKeys(email);
    const p = await this.passwordField();
    await this.driver.executeScript("arguments[0].focus();", p);
    await this.driver.executeScript("arguments[0].value = '';", p);
    await p.sendKeys(password);
    await (await this.submitButton()).click();
  }
}

// ── Test definitions ────────────────────────────────────────────────────────

function buildTests(page) {
  const t = [];
  const add = (suite, title, expected, fn) =>
    t.push({ id: `LOGIN-${String(t.length + 1).padStart(3, "0")}`, suite, title, expected, fn });

  // ---- 1. Rendering ------------------------------------------------------
  add("Login — Rendering", "Login screen loads and mounts the React tree",
    "#root renders content on /login", async () => {
      await page.open();
      const n = await page.driver.executeScript(
        "return document.getElementById('root').children.length;");
      assert(n > 0, "#root is empty");
      return `#root rendered ${n} child node(s)`;
    });

  add("Login — Rendering", "Brand heading identifies the product",
    "h1 reads 'MediGuard'", async () => {
      await page.open();
      const h1 = (await (await page.driver.findElement(By.css("h1"))).getText()).trim();
      assertEqual(h1, "MediGuard", "h1");
      return h1;
    });

  add("Login — Rendering", "Tagline is shown beneath the brand",
    "'Your Personal Medicine Guardian' is visible", async () => {
      await page.open();
      const body = await page.driver.executeScript("return document.body.innerText;");
      assert(body.includes("Your Personal Medicine Guardian"), "tagline missing");
      return "tagline rendered";
    });

  add("Login — Rendering", "Email and password fields are both present",
    "exactly 2 inputs inside the form", async () => {
      await page.open();
      const n = await page.driver.executeScript(
        "return document.querySelectorAll('form input').length;");
      assertEqual(n, 2, "form input count");
      return `${n} inputs`;
    });

  add("Login — Rendering", "Google federated sign-in is offered",
    "'Continue with Google' button exists", async () => {
      await page.open();
      const label = (await (await page.googleButton()).getText()).trim();
      assertMatch(label, /Continue with Google/, "google button");
      return label;
    });

  add("Login — Rendering", "Document title is set for the tab and history",
    "title === 'MediGuard'", async () => {
      await page.open();
      const title = await page.driver.getTitle();
      assertEqual(title, "MediGuard", "document.title");
      return title;
    });

  // ---- 2. Mode switching -------------------------------------------------
  add("Login — Mode Switching", "Default mode is Sign In",
    "submit button reads 'Sign In'", async () => {
      await page.open();
      const label = await page.submitLabel();
      assertEqual(label, "Sign In", "default submit label");
      return label;
    });

  add("Login — Mode Switching", "Switching to Sign Up changes the primary action",
    "submit button reads 'Create Account'", async () => {
      await page.open();
      await (await page.tab("Sign Up")).click();
      const label = await page.submitLabel();
      assertEqual(label, "Create Account", "submit label after switching");
      return label;
    });

  add("Login — Mode Switching", "Switching back to Sign In restores the action",
    "submit button reads 'Sign In' again", async () => {
      await page.open();
      await (await page.tab("Sign Up")).click();
      await (await page.tab("Sign In")).click();
      const label = await page.submitLabel();
      assertEqual(label, "Sign In", "submit label after switching back");
      return label;
    });

  add("Login — Mode Switching", "Forgot-password link is offered only when signing in",
    "link absent on the Sign Up tab", async () => {
      await page.open();
      await (await page.tab("Sign Up")).click();
      const els = await page.driver.findElements(By.xpath("//button[contains(.,'Forgot password')]"));
      assertEqual(els.length, 0, "forgot-password link count");
      return "link correctly hidden while registering";
    });

  add("Login — Mode Switching", "Switching modes clears any stale error banner",
    "no error element after the switch", async () => {
      await page.open();
      await page.signIn("nobody@example.com", "wrong-password");
      await page.driver.sleep(1500);
      await (await page.tab("Sign Up")).click();
      const err = await page.errorText();
      assertEqual(err, "", "error text after mode switch");
      return "stale error cleared";
    });

  // ---- 3. Credential handling -------------------------------------------
  add("Login — Credential Handling", "Password is masked by default",
    "input type is 'password'", async () => {
      await page.open();
      const type = await page.passwordType();
      assertEqual(type, "password", "password input type");
      return type;
    });

  add("Login — Credential Handling", "'Show' reveals the password on demand",
    "input type becomes 'text'", async () => {
      await page.open();
      await (await page.driver.findElement(By.xpath("//button[normalize-space()='Show']"))).click();
      const type = await page.passwordType();
      assertEqual(type, "text", "password input type after Show");
      return type;
    });

  add("Login — Credential Handling", "'Hide' re-masks the password",
    "input type returns to 'password'", async () => {
      await page.open();
      await (await page.driver.findElement(By.xpath("//button[normalize-space()='Show']"))).click();
      await (await page.driver.findElement(By.xpath("//button[normalize-space()='Hide']"))).click();
      const type = await page.passwordType();
      assertEqual(type, "password", "password input type after Hide");
      return type;
    });

  add("Login — Credential Handling", "Password is never written to localStorage",
    "no stored value contains the secret", async () => {
      await page.open();
      const p = await page.passwordField();
      await p.sendKeys("N0t-Persisted!");
      const leaked = await page.driver.executeScript(`
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if ((localStorage.getItem(k) || '').indexOf('N0t-Persisted!') !== -1) return k;
        }
        return null;`);
      assertEqual(leaked, null, "localStorage leak");
      return "secret not persisted";
    });

  add("Login — Credential Handling", "Password is never written to a cookie",
    "document.cookie does not contain the secret", async () => {
      await page.open();
      const p = await page.passwordField();
      await p.sendKeys("N0t-In-Cookies!");
      const cookie = await page.driver.executeScript("return document.cookie;");
      assert(!cookie.includes("N0t-In-Cookies!"), "password leaked into cookies");
      return "secret not in cookies";
    });

  add("Login — Credential Handling", "Password survives special characters intact",
    "typed symbols round-trip exactly", async () => {
      await page.open();
      const pw = "P@ss!#$%&*()_+-=";
      const p = await page.passwordField();
      await p.sendKeys(pw);
      const v = await page.driver.executeScript(
        "return document.querySelectorAll('form input')[1].value;");
      assertEqual(v, pw, "password round-trip");
      return "symbols preserved";
    });

  // ---- 4. Client-side validation ----------------------------------------
  add("Login — Validation", "Empty form does not satisfy constraint validation",
    "form.checkValidity() === false", async () => {
      await page.open();
      const valid = await page.driver.executeScript(
        "return document.querySelector('form').checkValidity();");
      assertEqual(valid, false, "empty form validity");
      return "submission blocked while fields are empty";
    });

  add("Login — Validation", "Both fields filled satisfies constraint validation",
    "form.checkValidity() === true", async () => {
      await page.open();
      const e = await page.emailField();
      await e.sendKeys("user@example.com");
      const p = await page.passwordField();
      await p.sendKeys("secret123");
      const valid = await page.driver.executeScript(
        "return document.querySelector('form').checkValidity();");
      assertEqual(valid, true, "filled form validity");
      return "form is submittable";
    });

  // A representative slice of the full 24-address table in lib/catalog.js.
  for (const addr of VALID_EMAILS.slice(0, 6)) {
    add("Login — Validation", `Accepts a well-formed address: ${addr}`,
      "input.checkValidity() === true", async () => {
        await page.open();
        const e = await page.emailField();
        await e.sendKeys(addr);
        const valid = await page.driver.executeScript(
          "return document.querySelector('input[type=email]').checkValidity();");
        assertEqual(valid, true, `validity for ${addr}`);
        return `${addr} accepted`;
      });
  }

  for (const addr of INVALID_EMAILS.slice(0, 6)) {
    add("Login — Validation", `Rejects a malformed address: ${JSON.stringify(addr)}`,
      "input.checkValidity() === false", async () => {
        await page.open();
        const e = await page.emailField();
        await e.sendKeys(addr);
        const valid = await page.driver.executeScript(
          "return document.querySelector('input[type=email]').checkValidity();");
        assertEqual(valid, false, `validity for ${addr}`);
        return `${JSON.stringify(addr)} rejected`;
      });
  }

  // ---- 5. Authorisation boundary ----------------------------------------
  // Every protected route, not a sample: this is the guard that stands between
  // an anonymous visitor and a patient's medication record.
  for (const route of PROTECTED_ROUTES) {
    add("Login — Access Control",
      `Anonymous visitor is redirected away from ${route.path} (${route.name})`,
      "pathname becomes /login", async () => {
        await goto(page.driver, page.baseUrl, route.path);
        const p = await page.path();
        assertEqual(p, "/login", `guard for ${route.path}`);
        return `${route.path} -> ${p}`;
      });
  }

  // ---- 6. Failure behaviour ---------------------------------------------
  add("Login — Failure Handling", "Invalid credentials keep the user on /login",
    "pathname stays /login after a rejected sign-in", async () => {
      await page.open();
      await page.signIn("nobody@example.com", "definitely-wrong");
      await page.driver.sleep(2000);
      const p = await page.path();
      assertEqual(p, "/login", "pathname after failed sign-in");
      return "user retained on the login screen";
    });

  add("Login — Failure Handling", "Invalid credentials do not reveal which field was wrong",
    "no 'user not found' style disclosure", async () => {
      await page.open();
      await page.signIn("nobody@example.com", "definitely-wrong");
      await page.driver.sleep(2000);
      const err = await page.errorText();
      assert(!/user.?not.?found|no such user|unknown email/i.test(err),
        `error text discloses account existence: ${err}`);
      return err ? `generic message shown: "${err}"` : "no disclosure";
    });

  add("Login — Failure Handling", "Invalid credentials do not surface a stack trace",
    "no frame-like text rendered", async () => {
      await page.open();
      await page.signIn("nobody@example.com", "definitely-wrong");
      await page.driver.sleep(2000);
      const body = await page.driver.executeScript("return document.body.innerText;");
      assert(!/at\s+\w+\s+\(.*:\d+:\d+\)/.test(body), "stack trace rendered to the user");
      return "no stack trace surfaced";
    });

  add("Login — Failure Handling", "Submit button is re-enabled after a failure",
    "button.disabled === false", async () => {
      await page.open();
      await page.signIn("nobody@example.com", "definitely-wrong");
      await page.driver.sleep(2500);
      const disabled = await page.driver.executeScript(
        "return document.querySelector('form button[type=submit]').disabled;");
      assertEqual(disabled, false, "submit disabled after failure");
      return "user can retry";
    });

  add("Login — Failure Handling", "Failed sign-in leaves no session artefacts behind",
    "app still renders the signed-out state", async () => {
      await page.open();
      await page.signIn("nobody@example.com", "definitely-wrong");
      await page.driver.sleep(2000);
      await page.driver.navigate().refresh();
      await page.driver.wait(async () => page.driver.executeScript(
        "return !document.body.innerText.includes('Loading MediGuard');"), 15000);
      const els = await page.driver.findElements(By.css("input[type=email]"));
      assertEqual(els.length, 1, "login form after refresh");
      return "still signed out after refresh";
    });

  // ---- 7. Navigation -----------------------------------------------------
  add("Login — Navigation", "'Forgot password?' opens the reset flow",
    "pathname becomes /forgot-password", async () => {
      await page.open();
      await (await page.forgotPasswordLink()).click();
      await page.driver.wait(async () => (await page.path()) === "/forgot-password", 8000);
      return await page.path();
    });

  add("Login — Navigation", "Browser back returns from the reset flow to login",
    "pathname returns to /login", async () => {
      await page.open();
      await (await page.forgotPasswordLink()).click();
      await page.driver.wait(async () => (await page.path()) === "/forgot-password", 8000);
      await page.driver.navigate().back();
      await page.driver.wait(async () => (await page.path()) === "/login", 8000);
      return await page.path();
    });

  add("Login — Navigation", "Keyboard tabbing moves from email to password",
    "focus lands on the credential field", async () => {
      await page.open();
      const e = await page.emailField();
      await e.click();
      await e.sendKeys(Key.TAB);
      const type = await page.driver.executeScript("return document.activeElement.type;");
      assert(["password", "text"].includes(type), `focus went to ${type}`);
      return `focus type = ${type}`;
    });

  return t;
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("MediGuard — Selenium E2E: authentication surface");
  console.log("=".repeat(64));

  if (!fs.existsSync(DIST)) {
    console.error(`ERROR: no build at ${DIST}`);
    console.error("Run:  pnpm --filter @mediguard/web build");
    process.exit(2);
  }

  const site = await startServer(DIST);
  const driver = await createDriver();
  const caps = await driver.getCapabilities();
  const browser = `${caps.get("browserName")} ${caps.get("browserVersion")}`;

  console.log(`Serving : ${site.baseUrl}`);
  console.log(`Browser : ${browser}`);
  console.log("=".repeat(64));

  const page = new LoginPage(driver, site.baseUrl);
  const tests = buildTests(page);
  const results = [];
  const startedAt = new Date();

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const t0 = Date.now();
    let status = "PASS";
    let actual = "";
    let error = "";
    try {
      actual = (await t.fn()) || "assertion satisfied";
    } catch (e) {
      status = "FAIL";
      error = (e && e.message ? e.message : String(e)).split("\n").slice(0, 4).join(" | ");
      actual = "assertion failed";
    }
    const durationMs = Date.now() - t0;
    results.push({
      id: t.id,
      suite: t.suite,
      title: t.title,
      steps: ["Open the MediGuard login screen", "Perform the interaction under test", `Assert: ${t.expected}`],
      expected: t.expected,
      actual,
      status,
      error,
      durationMs,
    });
    console.log(`${String(i + 1).padStart(3)}/${tests.length}  ${status}  ${t.id}  ${t.title.slice(0, 60)}`);
    if (status === "FAIL") console.log(`         -> ${error}`);
  }

  await driver.quit();
  await site.close();

  const finishedAt = new Date();
  const summary = await writeReport({
    outFile: OUT,
    title: "MediGuard — Selenium Login / Authentication E2E Report",
    meta: {
      "Application": "MediGuard Web (apps/web)",
      "Focus": "Authentication, credential handling, access control",
      "Framework": "Selenium WebDriver 4 (Node.js)",
      "Browser": browser,
      "Base URL": site.baseUrl,
      "Started at": startedAt.toISOString(),
      "Finished at": finishedAt.toISOString(),
    },
    results,
  });

  console.log("=".repeat(64));
  console.log(`Total ${summary.total} | Passed ${summary.passed} | Failed ${summary.failed} | ${summary.passRate}`);
  console.log(`Report: ${OUT}`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(2);
  });
}

module.exports = { LoginPage, buildTests };
