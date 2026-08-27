"use strict";
/**
 * Chrome WebDriver factory.
 *
 * Headless by default so the same command works on a laptop and on a CI runner
 * with no display. Set HEADLESS=false to watch a run.
 *
 * The flags are the standard container set: --no-sandbox and
 * --disable-dev-shm-usage are required on GitHub-hosted runners, where the
 * sandbox is unavailable and /dev/shm is only 64MB (Chrome crashes mid-run
 * without the second flag, which shows up as random "target closed" failures).
 */

const { Builder, By, until, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

async function createDriver() {
  const headless = process.env.HEADLESS !== "false";
  const options = new chrome.Options();

  if (headless) options.addArguments("--headless=new");
  options.addArguments(
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-search-engine-choice-screen",
    "--window-size=" + DEFAULT_VIEWPORT.width + "," + DEFAULT_VIEWPORT.height,
    // Deterministic locale/timezone: several assertions compare rendered dates.
    "--lang=en-US",
  );
  // Surface browser console output to the driver log so suite 09 can assert on it.
  options.setLoggingPrefs({ browser: "ALL" });

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();

  await driver.manage().setTimeouts({ implicit: 0, pageLoad: 30000, script: 20000 });
  await driver.manage().window().setRect(DEFAULT_VIEWPORT);
  return driver;
}

/**
 * Navigate, wait for React's first paint, then wait out the auth gate.
 *
 * App.tsx renders a "Loading MediGuard…" splash until the Firebase auth
 * listener has reported in. Asserting while that splash is up produces
 * flaky "element not found" failures on a slow runner, so every navigation
 * waits for it to clear before the test body runs.
 */
async function goto(driver, baseUrl, route) {
  await driver.get(baseUrl + route);
  await driver.wait(async () => {
    return driver.executeScript(
      "var r = document.getElementById('root'); return !!r && r.children.length > 0;"
    );
  }, 15000, `#root never rendered for route ${route}`);

  await driver.wait(async () => {
    const settled = await driver.executeScript(
      "return !document.body.innerText.includes('Loading MediGuard');"
    );
    return settled;
  }, 15000, `auth gate never settled for route ${route}`);
}

const $ = (sel) => By.css(sel);
const xp = (expr) => By.xpath(expr);

module.exports = { createDriver, goto, $, xp, By, until, Key, DEFAULT_VIEWPORT };
