"use strict";
/**
 * Appium (UiAutomator2) driver factory — used only in MODE=device.
 *
 * webdriverio is an optionalDependency: the contract mode that CI runs must not
 * require a 200MB automation stack to be installed just to parse the app source.
 * So the module is required lazily and a missing install produces an actionable
 * message instead of a stack trace at import time.
 *
 * To run for real:
 *
 *   1. Install the tooling
 *        npm i -D webdriverio appium
 *        npx appium driver install uiautomator2
 *   2. Start a device (emulator or USB) and the server
 *        npx appium
 *   3. Build a debug APK of apps/mobile (EAS, or `npx expo run:android`)
 *   4. Point the suite at it
 *        MODE=device APP_PATH=/abs/path/MediGuard.apk node run.js
 */

const path = require("path");

const CAPS = {
  platformName: "Android",
  "appium:automationName": "UiAutomator2",
  "appium:appPackage": process.env.APP_PACKAGE || "com.mediguard.app",
  "appium:appActivity": process.env.APP_ACTIVITY || ".MainActivity",
  "appium:newCommandTimeout": 240,
  "appium:autoGrantPermissions": true,
  // The RN bridge takes a beat to mount the NavigationContainer; without this
  // the first findElement races the splash screen.
  "appium:appWaitDuration": 30000,
};

function describeCapabilities() {
  const caps = { ...CAPS };
  if (process.env.APP_PATH) caps["appium:app"] = path.resolve(process.env.APP_PATH);
  if (process.env.DEVICE_NAME) caps["appium:deviceName"] = process.env.DEVICE_NAME;
  if (process.env.PLATFORM_VERSION) caps["appium:platformVersion"] = process.env.PLATFORM_VERSION;
  return caps;
}

async function createDriver() {
  let remote;
  try {
    ({ remote } = require("webdriverio"));
  } catch {
    throw new Error(
      "MODE=device requires webdriverio, which is not installed.\n" +
      "  npm i -D webdriverio appium\n" +
      "  npx appium driver install uiautomator2\n" +
      "Then start a device and `npx appium`, and re-run with MODE=device."
    );
  }

  const url = new URL(process.env.APPIUM_URL || "http://127.0.0.1:4723");

  return remote({
    protocol: url.protocol.replace(":", ""),
    hostname: url.hostname,
    port: Number(url.port || 4723),
    path: url.pathname === "/" ? "/" : url.pathname,
    logLevel: process.env.APPIUM_LOG_LEVEL || "error",
    capabilities: describeCapabilities(),
  });
}

/** Wait for an element addressed by visible text, the app's only stable handle. */
async function byText(driver, text, timeout = 15000) {
  const el = await driver.$(`android=new UiSelector().text("${text}")`);
  await el.waitForDisplayed({ timeout });
  return el;
}

/** Wait for an element whose text merely contains a fragment. */
async function byPartialText(driver, fragment, timeout = 15000) {
  const el = await driver.$(`android=new UiSelector().textContains("${fragment}")`);
  await el.waitForDisplayed({ timeout });
  return el;
}

module.exports = { createDriver, describeCapabilities, byText, byPartialText, CAPS };
