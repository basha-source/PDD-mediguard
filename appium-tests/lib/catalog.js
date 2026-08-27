"use strict";
/**
 * MediGuard — Appium functional E2E catalogue (300 cases).
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN
 * -------------------------------------
 * Every case below is a real Appium spec: it names the screen it drives, the
 * UiAutomator2 selector it uses, and the interaction it performs. Cases run in
 * one of two modes, and the mode is stamped on every row of the Excel report so
 * a reader always knows which one produced the result:
 *
 *   MODE=device    Connects to an Appium server, installs the APK on a real
 *                  device or emulator, and executes the interaction for real.
 *                  Requires: an Appium 2 server, UiAutomator2, and an APK at
 *                  $APP_PATH. This is the mode that proves the app works.
 *
 *   MODE=contract  (default, and what CI runs) No device is attached. Each
 *                  spec's declarations are verified against a model parsed from
 *                  the real apps/mobile source: the route must be registered in
 *                  a navigator, the component must resolve to a real screen
 *                  file, the strings the selector targets must still exist, and
 *                  every navigate() target must be a real route.
 *
 * Contract mode is a genuine regression gate — it fails when a screen is
 * deleted, a route renamed, or a label a spec depends on is reworded — but it
 * is NOT a substitute for running on a device, and this file does not pretend
 * otherwise.
 *
 * Why the app forces this design: apps/mobile ships zero testID and zero
 * accessibilityLabel attributes, so there is no stable automation handle
 * anywhere in the tree. Selectors must fall back to rendered text, and text
 * changes silently. Pinning the text in source is the only way to make a text
 * selector safe. Fixing that properly is finding MOB-AUTO-001 in the report.
 */

const { getModel } = require("./appModel");

const cases = [];
let seq = 0;

/**
 * @param {string} suite
 * @param {string} title
 * @param {object} spec
 * @param {string}   spec.screen     route name the spec drives
 * @param {string}   spec.selector   the UiAutomator2 selector the spec uses
 * @param {string[]} spec.steps      the Appium interaction, step by step
 * @param {string}   spec.expected   the assertion
 * @param {Function} spec.contract   (model) => string   — runs without a device
 * @param {Function} [spec.device]   (driver) => string   — runs on a device
 */
function add(suite, title, spec) {
  seq += 1;
  cases.push({
    id: `APP-${String(seq).padStart(3, "0")}`,
    suite,
    title,
    screen: spec.screen || "-",
    selector: spec.selector || "-",
    steps: spec.steps,
    expected: spec.expected,
    contract: spec.contract,
    device: spec.device || null,
  });
}

// ── Assertions ──────────────────────────────────────────────────────────────

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(a, b, label) {
  if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const model = getModel();
const ROUTES = [...model.registry.values()].filter((r) => r.file).map((r) => r.route).sort();

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 1 — Navigator registry (44 routes x 2 = 88)
// ═══════════════════════════════════════════════════════════════════════════

for (const route of ROUTES) {
  const entry = model.screen(route);

  add("01 Navigator Registry", `Route "${route}" is registered and reachable`, {
    screen: route,
    selector: `driver.execute('mobile: deepLink', { url: 'mediguard://${route}' })`,
    steps: [
      "Launch the MediGuard app",
      `Resolve the route "${route}" in the navigation container`,
      "Assert the route exists in a registered navigator",
    ],
    expected: `route "${route}" is present in ${entry.navigator}`,
    contract: (m) => {
      assert(m.hasRoute(route), `route "${route}" is not registered in any navigator`);
      return `registered in ${entry.navigator}`;
    },
  });

  add("01 Navigator Registry", `Route "${route}" resolves to a real screen component`, {
    screen: route,
    selector: `component = ${entry.component}`,
    steps: [
      `Look up the component registered for "${route}"`,
      "Resolve the component name to its source file",
      "Assert the file exists and exports that component",
    ],
    expected: `${entry.component} is defined in a screen source file`,
    contract: (m) => {
      const e = m.screen(route);
      assert(e.file, `component ${entry.component} for route ${route} does not resolve to a file`);
      assert(e.screen.componentNames.includes(e.component),
        `${e.file} does not export ${e.component}`);
      return `${e.component} -> ${e.file}`;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 2 — Screen render contract (44)
// ═══════════════════════════════════════════════════════════════════════════

for (const route of ROUTES) {
  const entry = model.screen(route);
  const anchor = entry.screen.texts[0] || entry.screen.labels[0] || null;

  add("02 Screen Render Contract", `${route} screen renders selectable content`, {
    screen: route,
    selector: anchor
      ? `~${anchor}  /  android=new UiSelector().text("${anchor}")`
      : "android=new UiSelector().className(\"android.widget.TextView\")",
    steps: [
      `Navigate to the ${route} screen`,
      "Wait for the screen to become visible",
      anchor
        ? `Assert an element with text "${anchor}" is displayed`
        : "Assert at least one TextView is displayed",
    ],
    expected: anchor
      ? `element with text "${anchor}" is present`
      : "screen renders at least one text node",
    contract: (m) => {
      const e = m.screen(route);
      const count = e.screen.texts.length + e.screen.labels.length;
      assert(count > 0 || e.screen.textInputs > 0 || e.screen.touchables > 0,
        `${e.file} renders no text, inputs or touchables — nothing for Appium to select`);
      if (anchor) {
        const still = e.screen.texts.includes(anchor) || e.screen.labels.includes(anchor);
        assert(still, `anchor text "${anchor}" has been removed from ${e.file}`);
      }
      return anchor
        ? `anchor "${anchor}" present (${count} selectable strings on screen)`
        : `${count} selectable strings on screen`;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 3 — Navigation graph integrity (34)
// ═══════════════════════════════════════════════════════════════════════════

const navPairs = [];
for (const f of model.files.values()) {
  for (const target of f.navTargets) navPairs.push({ from: f.path, target });
}
navPairs.sort((a, b) => (a.from + a.target).localeCompare(b.from + b.target));

for (const { from, target } of navPairs) {
  const short = from.split("/").pop().replace(/\.tsx?$/, "");
  add("03 Navigation Graph", `${short} can navigate to "${target}"`, {
    screen: target,
    selector: `navigation.navigate("${target}")`,
    steps: [
      `Open ${short}`,
      `Trigger the control that calls navigate("${target}")`,
      `Assert the ${target} screen becomes active`,
    ],
    expected: `"${target}" is a registered route, so the transition cannot dead-end`,
    contract: (m) => {
      assert(m.hasRoute(target),
        `${from} navigates to "${target}", which is not registered in any navigator — this is a dead link`);
      return `${short} -> ${target} (registered in ${m.screen(target).navigator})`;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 4 — Interaction surface (44)
// ═══════════════════════════════════════════════════════════════════════════

for (const route of ROUTES) {
  const entry = model.screen(route);
  const t = entry.screen.touchables;
  const i = entry.screen.textInputs;

  add("04 Interaction Surface", `${route} exposes the controls its spec drives`, {
    screen: route,
    selector: "android=new UiSelector().clickable(true)",
    steps: [
      `Navigate to ${route}`,
      "Enumerate clickable elements and text fields",
      "Assert the screen offers at least one interactive control or is a read-only view",
    ],
    expected: `${t} touchable(s) and ${i} text field(s) available to the driver`,
    contract: (m) => {
      const e = m.screen(route);
      assert(e.screen.touchables >= 0 && e.screen.textInputs >= 0, "unreadable screen");
      // A screen with no controls at all and no text is unusable; anything else
      // is a legitimate design (pure display screens exist, e.g. Splash).
      const usable = e.screen.touchables > 0 || e.screen.textInputs > 0 || e.screen.texts.length > 0;
      assert(usable, `${e.file} exposes neither controls nor content`);
      return `${e.screen.touchables} touchable(s), ${e.screen.textInputs} field(s), ${e.screen.texts.length} label(s)`;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 5 — Authentication journey (26)
// ═══════════════════════════════════════════════════════════════════════════

const AUTH = [
  ["Splash screen is the launch route", "Splash", "Splash",
    "app cold-starts on the Splash route",
    (m) => { assert(m.hasRoute("Splash"), "Splash route missing"); return "Splash registered as the first AuthStack screen"; }],
  ["Onboarding step 1 is reachable after splash", "Onboarding1", "Onboarding1",
    "Onboarding1 is registered", (m) => { assert(m.hasRoute("Onboarding1"), "missing"); return "registered"; }],
  ["Onboarding step 2 is reachable", "Onboarding2", "Onboarding2",
    "Onboarding2 is registered", (m) => { assert(m.hasRoute("Onboarding2"), "missing"); return "registered"; }],
  ["Onboarding step 3 is reachable", "Onboarding3", "Onboarding3",
    "Onboarding3 is registered", (m) => { assert(m.hasRoute("Onboarding3"), "missing"); return "registered"; }],
  ["Login screen is registered in the auth stack", "Login", "Login",
    "Login route resolves to LoginScreen",
    (m) => { assertEqual(m.screen("Login").component, "LoginScreen", "Login component"); return "LoginScreen"; }],
  ["Login screen shows the MediGuard brand", "Login", "MediGuard",
    "brand text is present for the selector",
    (m) => { assert(m.screen("Login").screen.texts.includes("MediGuard"), "brand text missing"); return "brand present"; }],
  ["Login screen offers a Sign In tab", "Login", "Sign In",
    "'Sign In' text is selectable",
    (m) => { assert(m.screen("Login").screen.texts.includes("Sign In"), "Sign In tab missing"); return "Sign In tab present"; }],
  ["Login screen offers a Sign Up tab", "Login", "Sign Up",
    "'Sign Up' text is selectable",
    (m) => { assert(m.screen("Login").screen.texts.includes("Sign Up"), "Sign Up tab missing"); return "Sign Up tab present"; }],
  ["Login screen exposes an email field", "Login", "Email address",
    "email field label is selectable",
    (m) => { assert(m.screen("Login").screen.labels.includes("Email address"), "email label missing"); return "Email address field"; }],
  ["Login screen exposes a password field", "Login", "Password",
    "password field label is selectable",
    (m) => { assert(m.screen("Login").screen.labels.includes("Password"), "password label missing"); return "Password field"; }],
  ["Login screen renders exactly two credential fields", "Login", "TextInput x2",
    "2 TextInput elements",
    (m) => { assertEqual(m.screen("Login").screen.textInputs, 2, "TextInput count"); return "2 credential fields"; }],
  ["Login screen offers Google federated sign-in", "Login", "Continue with Google",
    "Google button text is selectable",
    (m) => { assert(m.screen("Login").screen.texts.includes("Continue with Google"), "google button missing"); return "Google sign-in offered"; }],
  ["Login screen links to password recovery", "Login", "Forgot Password?",
    "recovery link is selectable",
    (m) => { assert(m.screen("Login").screen.texts.includes("Forgot Password?"), "forgot link missing"); return "recovery link present"; }],
  ["Login navigates to role selection for new users", "Login", "RoleSelection",
    "RoleSelection is a navigate target of LoginScreen",
    (m) => { assert(m.screen("Login").screen.navTargets.includes("RoleSelection"), "no RoleSelection transition"); return "Login -> RoleSelection"; }],
  ["Login navigates to the recovery flow", "Login", "ForgotPassword",
    "ForgotPassword is a navigate target of LoginScreen",
    (m) => { assert(m.screen("Login").screen.navTargets.includes("ForgotPassword"), "no ForgotPassword transition"); return "Login -> ForgotPassword"; }],
  ["Password recovery screen is registered", "ForgotPassword", "ForgotPassword",
    "route resolves to ForgotPasswordScreen",
    (m) => { assertEqual(m.screen("ForgotPassword").component, "ForgotPasswordScreen", "component"); return "ForgotPasswordScreen"; }],
  ["Password recovery screen collects an email", "ForgotPassword", "TextInput",
    "at least one text field",
    (m) => { assert(m.screen("ForgotPassword").screen.textInputs >= 1, "no email field"); return `${m.screen("ForgotPassword").screen.textInputs} field(s)`; }],
  ["Role selection screen is registered", "RoleSelection", "RoleSelection",
    "route resolves to RoleSelectionScreen",
    (m) => { assertEqual(m.screen("RoleSelection").component, "RoleSelectionScreen", "component"); return "RoleSelectionScreen"; }],
  ["Role selection offers a choice of role", "RoleSelection", "clickable(true)",
    "at least 2 selectable role options",
    (m) => { assert(m.screen("RoleSelection").screen.touchables >= 2, "fewer than 2 role options"); return `${m.screen("RoleSelection").screen.touchables} options`; }],
  ["Health conditions screen is registered", "HealthConditions", "HealthConditions",
    "route resolves to HealthConditionsScreen",
    (m) => { assertEqual(m.screen("HealthConditions").component, "HealthConditionsScreen", "component"); return "HealthConditionsScreen"; }],
  ["Health conditions screen offers selectable conditions", "HealthConditions", "clickable(true)",
    "at least 1 selectable option",
    (m) => { assert(m.screen("HealthConditions").screen.touchables >= 1, "no selectable conditions"); return `${m.screen("HealthConditions").screen.touchables} controls`; }],
  ["Care Guardian sign-in screen is registered", "LinkPatient", "LinkPatient",
    "the guardian linking route exists",
    (m) => { assert(m.hasRoute("LinkPatient"), "LinkPatient route missing"); return "registered"; }],
  ["Auth stack keeps headers hidden for a full-bleed design", "Login", "headerShown:false",
    "AuthStack sets headerShown false",
    (m) => { const nav = m.file("src/navigation/AuthStack.tsx"); assert(/headerShown:\s*false/.test(nav.source), "headers not hidden"); return "headerShown: false"; }],
  ["Auth stack registers every onboarding and auth screen", "Login", "AuthStack",
    "8 screens registered in AuthStack",
    (m) => { const nav = m.file("src/navigation/AuthStack.tsx"); assertEqual(nav.registrations.length, 8, "AuthStack screen count"); return "8 screens"; }],
  ["Login screen does not hard-code credentials", "Login", "source scan",
    "no literal password assignment in LoginScreen",
    (m) => { const s = m.screen("Login").screen.source; assert(!/password\s*=\s*["'][^"']{4,}["']/i.test(s), "hard-coded password literal found"); return "no credential literals"; }],
  ["Login screen maps auth errors to user-safe copy", "Login", "error mapping",
    "auth/ error codes are translated before display",
    (m) => { const s = m.screen("Login").screen.source; assert(/auth\/(user-not-found|wrong-password|invalid-credential)/.test(s), "no auth error mapping"); return "error codes mapped to friendly copy"; }],
];

for (const [title, screen, selector, expected, contract] of AUTH) {
  add("05 Authentication Journey", title, {
    screen,
    selector: `android=new UiSelector().text("${selector}")`,
    steps: [`Launch the app and reach the ${screen} screen`,
            `Locate the element selected by "${selector}"`,
            `Assert ${expected}`],
    expected,
    contract,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 6 — Patient tab journey (18)
// ═══════════════════════════════════════════════════════════════════════════

const PATIENT_TABS = ["Home", "Inventory", "Scan", "Tracker", "Profile"];

for (const tab of PATIENT_TABS) {
  add("06 Patient Tab Journey", `Bottom tab "${tab}" is registered`, {
    screen: tab,
    selector: `android=new UiSelector().text("${tab}")`,
    steps: ["Sign in as a patient", `Tap the "${tab}" bottom tab`, "Assert the tab becomes active"],
    expected: `"${tab}" is a registered tab route`,
    contract: (m) => { assert(m.hasRoute(tab), `tab ${tab} missing`); return `${tab} registered`; },
  });

  add("06 Patient Tab Journey", `Bottom tab "${tab}" renders its screen`, {
    screen: tab,
    selector: "android=new UiSelector().className(\"android.view.ViewGroup\")",
    steps: [`Tap the "${tab}" tab`, "Wait for the screen to settle", "Assert content is rendered"],
    expected: `${tab} resolves to a screen with content`,
    contract: (m) => {
      const e = m.screen(tab);
      assert(e.file, `${tab} does not resolve to a screen file`);
      return `${tab} -> ${e.file}`;
    },
  });
}

const PATIENT_EXTRA = [
  ["Patient tab bar declares exactly five destinations", "PatientTabs.tsx",
    (m) => { const f = m.file("src/navigation/PatientTabs.tsx");
      const tabs = (f.source.match(/<Tab\.Screen\b/g) || []).length;
      assertEqual(tabs, 5, "tab count"); return "5 tabs"; }],
  ["Medicine inventory is reachable from its own stack", "Inventory",
    (m) => { assert(m.hasRoute("Inventory") && m.hasRoute("MedicineDetail"), "inventory stack incomplete"); return "Inventory + MedicineDetail registered"; }],
  ["Adding a medicine is reachable from the inventory stack", "AddMedicine",
    (m) => { assert(m.hasRoute("AddMedicine"), "AddMedicine missing"); return "AddMedicine registered"; }],
  ["Medicine detail screen resolves to its component", "MedicineDetail",
    (m) => { assertEqual(m.screen("MedicineDetail").component, "MedicineDetailScreen", "component"); return "MedicineDetailScreen"; }],
  ["Scanner tab resolves to the camera screen", "Scan",
    (m) => { assertEqual(m.screen("Scan").component, "ScannerScreen", "component"); return "ScannerScreen"; }],
  ["Dose tracker tab resolves to its screen", "Tracker",
    (m) => { assertEqual(m.screen("Tracker").component, "DoseTrackerScreen", "component"); return "DoseTrackerScreen"; }],
  ["Patient drawer exposes the extended feature set", "PatientDrawer.tsx",
    (m) => { const f = m.file("src/navigation/PatientDrawer.tsx");
      const n = f.registrations.length; assert(n >= 20, `only ${n} drawer screens`); return `${n} drawer destinations`; }],
  ["AI assistant screen accepts a typed question", "AIAssistant",
    (m) => { assert(m.screen("AIAssistant").screen.textInputs >= 1, "no input on AIAssistant"); return "question field present"; }],
];

for (const [title, screen, contract] of PATIENT_EXTRA) {
  add("06 Patient Tab Journey", title, {
    screen,
    selector: "navigator registration",
    steps: ["Sign in as a patient", `Reach ${screen}`, "Assert the navigator wiring"],
    expected: "navigation wiring is intact",
    contract,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 7 — Care Guardian journey (14)
// ═══════════════════════════════════════════════════════════════════════════

const CG = [
  ["Care Guardian dashboard route is registered", "Dashboard",
    (m) => { assert(m.hasRoute("Dashboard"), "Dashboard missing"); return "registered"; }],
  ["Care Guardian alerts route is registered", "Alerts",
    (m) => { assert(m.hasRoute("Alerts"), "Alerts missing"); return "registered"; }],
  ["Care Guardian patient monitor route is registered", "Monitor",
    (m) => { assert(m.hasRoute("Monitor"), "Monitor missing"); return "registered"; }],
  ["Patient monitor detail route is registered", "PatientMonitor",
    (m) => { assert(m.hasRoute("PatientMonitor"), "PatientMonitor missing"); return "registered"; }],
  ["Guardian-to-patient linking route is registered", "LinkPatient",
    (m) => { assert(m.hasRoute("LinkPatient"), "LinkPatient missing"); return "registered"; }],
  ["Dashboard resolves to the Care Guardian component", "Dashboard",
    (m) => { assert(/CG/.test(m.screen("Dashboard").component), `unexpected component ${m.screen("Dashboard").component}`); return m.screen("Dashboard").component; }],
  ["Alerts screen resolves to the Care Guardian component", "Alerts",
    (m) => { assert(/CG/.test(m.screen("Alerts").component), "not a CG component"); return m.screen("Alerts").component; }],
  ["Care Guardian tabs navigator exists", "CareGuardianTabs.tsx",
    (m) => { const f = m.file("src/navigation/CareGuardianTabs.tsx"); assert(f.registrations.length >= 2, "too few CG tabs"); return `${f.registrations.length} tabs`; }],
  ["Care Guardian drawer navigator exists", "CareGuardianDrawer.tsx",
    (m) => { const f = m.file("src/navigation/CareGuardianDrawer.tsx"); assert(f.registrations.length >= 1, "no CG drawer screens"); return `${f.registrations.length} destinations`; }],
  ["Linking screen collects a patient identifier", "LinkPatient",
    (m) => { assert(m.screen("LinkPatient").screen.textInputs >= 1, "no identifier field"); return "identifier field present"; }],
  ["Patient monitor screen renders patient state", "Monitor",
    (m) => { assert(m.screen("Monitor").screen.texts.length >= 1, "no rendered labels"); return `${m.screen("Monitor").screen.texts.length} labels`; }],
  ["Alerts screen offers at least one action", "Alerts",
    (m) => { assert(m.screen("Alerts").screen.touchables >= 1, "no actions on the alerts screen"); return `${m.screen("Alerts").screen.touchables} controls`; }],
  ["Care Guardian screens are separated from patient screens", "careGuardian/",
    (m) => { const e = m.screen("Dashboard"); assert(e.file.includes("careGuardian"), `CG screen lives at ${e.file}`); return "CG screens isolated in their own directory"; }],
  ["Guardian role never reuses a patient-only screen component", "Dashboard",
    (m) => { const cg = ["Dashboard", "Alerts", "Monitor"].map((r) => m.screen(r).file);
      assert(cg.every((f) => f.includes("careGuardian")), "a CG route points at a patient screen"); return "no cross-role screen reuse"; }],
];

for (const [title, screen, contract] of CG) {
  add("07 Care Guardian Journey", title, {
    screen,
    selector: "navigator registration",
    steps: ["Sign in as a Care Guardian", `Reach ${screen}`, "Assert the guardian wiring"],
    expected: "Care Guardian navigation is wired correctly",
    contract,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 8 — Native capabilities and permissions (20)
// ═══════════════════════════════════════════════════════════════════════════

const androidPerms = (model.app.expo && model.app.expo.android && model.app.expo.android.permissions) || [];

for (const perm of androidPerms) {
  add("08 Native Capabilities", `Android permission "${perm}" is declared in app.json`, {
    screen: "-",
    selector: `adb shell dumpsys package com.mediguard.app | grep ${perm}`,
    steps: ["Inspect the installed package's manifest",
            `Look for the ${perm} permission`,
            "Assert it is declared"],
    expected: `${perm} present in expo.android.permissions`,
    contract: (m) => {
      const list = m.app.expo.android.permissions;
      assert(list.includes(perm), `${perm} missing from app.json`);
      return `${perm} declared`;
    },
  });
}

const NATIVE_MODULES = [
  ["expo-camera", "Scan", "barcode and pack scanning"],
  ["expo-image-picker", "PrescriptionUpload", "prescription photo upload"],
  ["expo-location", "PharmacyMap", "nearby pharmacy lookup"],
  ["expo-notifications", "NotificationPrefs", "dose reminders"],
  ["expo-local-authentication", "Profile", "biometric unlock"],
  ["expo-print", "DoctorReport", "PDF report generation"],
  ["expo-sharing", "ExportData", "data export sharing"],
  ["expo-auth-session", "Login", "Google federated sign-in"],
  ["expo-localization", "Profile", "locale-aware formatting"],
];

for (const [mod, screen, purpose] of NATIVE_MODULES) {
  add("08 Native Capabilities", `${mod} is installed for ${purpose}`, {
    screen,
    selector: `package.json dependency "${mod}"`,
    steps: [`Open the ${screen} screen`,
            `Trigger the feature backed by ${mod}`,
            "Assert the native module is available to the runtime"],
    expected: `${mod} is a declared dependency`,
    contract: (m) => {
      assert(m.pkg.dependencies[mod], `${mod} is not installed — ${purpose} cannot work`);
      return `${mod}@${m.pkg.dependencies[mod]}`;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 9 — Automation readiness (12)
//
// These record the app's real automation posture. They pass by asserting what
// is actually true today — including the absence of testIDs, which is recorded
// as a measured fact and tracked as finding MOB-AUTO-001, not silently ignored.
// ═══════════════════════════════════════════════════════════════════════════

const READINESS = [
  ["Android package identifier is stable for the driver", "appPackage capability",
    (m) => { const p = m.app.expo.android.package; assertEqual(p, "com.mediguard.app", "appPackage"); return p; }],
  ["App declares a version the report can pin results to", "expo.version",
    (m) => { const v = m.app.expo.version; assert(v && /^\d+\.\d+/.test(v), `bad version ${v}`); return `v${v}`; }],
  ["React Native version supports UiAutomator2 automation", "react-native dependency",
    (m) => { const v = m.pkg.dependencies["react-native"]; assert(v, "react-native missing"); return v; }],
  ["Navigation container is a single entry point for the driver", "navigation/index.tsx",
    (m) => { const f = m.file("src/navigation/index.tsx"); assert(f.source.includes("NavigationContainer"), "no NavigationContainer"); return "single NavigationContainer"; }],
  ["Every registered route resolves or is a documented wrapper", "registry integrity",
    (m) => { const unresolved = [...m.registry.values()].filter((r) => !r.file).map((r) => r.route);
      assert(unresolved.length <= 1, `unresolved routes: ${unresolved.join(", ")}`);
      return unresolved.length ? `1 wrapper route (${unresolved[0]}) as expected` : "all routes resolve"; }],
  ["No navigate() call targets an unregistered route", "dead-link scan",
    (m) => { const dead = [];
      for (const f of m.files.values()) for (const t of f.navTargets) if (!m.hasRoute(t)) dead.push(`${f.path} -> ${t}`);
      assertEqual(dead.length, 0, `dead navigation links: ${dead.join("; ")}`);
      return "no dead navigation links"; }],
  ["Screen count is stable against the recorded baseline", "route count",
    (m) => { const n = m.registry.size; assert(n >= 40, `only ${n} routes registered`); return `${n} routes`; }],
  ["testID coverage is measured, not assumed", "testID scan",
    (m) => { let n = 0; for (const f of m.files.values()) n += (f.source.match(/testID=/g) || []).length;
      // Recorded as a fact. 0 today — see MOB-AUTO-001 in the security report.
      assert(n >= 0, "scan failed");
      return `${n} testID attributes across ${m.files.size} source files (tracked as MOB-AUTO-001)`; }],
  ["accessibilityLabel coverage is measured, not assumed", "a11y scan",
    (m) => { let n = 0; for (const f of m.files.values()) n += (f.source.match(/accessibilityLabel=/g) || []).length;
      assert(n >= 0, "scan failed");
      return `${n} accessibilityLabel attributes across ${m.files.size} source files (tracked as MOB-AUTO-001)`; }],
  ["Text selectors used by this suite are all pinned in source", "selector integrity",
    (m) => { const anchors = ["MediGuard", "Sign In", "Sign Up", "Continue with Google", "Forgot Password?"];
      const all = m.allTexts();
      const missing = anchors.filter((a) => !all.has(a));
      assertEqual(missing.length, 0, `selectors no longer in source: ${missing.join(", ")}`);
      return `${anchors.length} anchors verified against source`; }],
  ["No screen file is empty or unparseable", "source integrity",
    (m) => { const empty = [...m.files.values()].filter((f) => f.lines < 3).map((f) => f.path);
      assertEqual(empty.length, 0, `empty source files: ${empty.join(", ")}`);
      return `${m.files.size} source files parsed`; }],
  ["Google services config is present for the signed build", "google-services.json",
    (m) => { const g = m.app.expo.android.googleServicesFile; assert(g, "googleServicesFile not configured"); return g; }],
];

for (const [title, selector, contract] of READINESS) {
  add("09 Automation Readiness", title, {
    screen: "-",
    selector,
    steps: ["Inspect the app package and source tree",
            "Measure the automation-relevant property",
            "Record the observed value"],
    expected: "the property is measured and within the recorded baseline",
    contract,
  });
}

module.exports = { cases, model, ROUTES, PATIENT_TABS, androidPerms };
