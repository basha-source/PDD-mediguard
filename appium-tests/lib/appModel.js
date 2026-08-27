"use strict";
/**
 * A queryable model of the MediGuard React Native app, built by reading the
 * real source in apps/mobile at run time.
 *
 * Why this exists
 * ---------------
 * The mobile app ships with zero `testID` and zero `accessibilityLabel`
 * attributes (verified: `grep -rn testID apps/mobile/src` returns nothing), so
 * an Appium suite has nothing stable to anchor on except rendered text. Text
 * selectors break silently the moment a label is reworded, and the failure
 * surfaces as "element not found" on a device an hour into a CI run.
 *
 * So the suite is anchored the other way round: every Appium spec declares the
 * screen it drives and the on-screen strings it will select by, and this model
 * proves those strings still exist in the source. When the suite runs against a
 * real device (MODE=device) the same declarations drive UiAutomator2. When it
 * runs without one (MODE=contract, the CI default) the declarations are checked
 * against the source instead.
 *
 * That makes the contract mode a genuine regression gate — it fails when a
 * screen is deleted, a navigation target is renamed, or a label a spec depends
 * on is reworded — while being honest that no device was involved.
 */

const fs = require("fs");
const path = require("path");

const MOBILE_ROOT = process.env.MOBILE_ROOT
  || path.resolve(__dirname, "..", "..", "apps", "mobile");
const SRC = path.join(MOBILE_ROOT, "src");

// ── Source loading ──────────────────────────────────────────────────────────

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

// ── Extractors ──────────────────────────────────────────────────────────────

/** Literal strings rendered inside <Text>…</Text>, de-duplicated. */
function extractTextLiterals(source) {
  const out = new Set();
  // <Text ...>Some literal</Text> — only literal children, not {expressions}.
  const re = /<Text\b[^>]*>([^<>{}]+)<\/Text>/g;
  let m;
  while ((m = re.exec(source))) {
    const text = m[1].replace(/\s+/g, " ").trim();
    if (text && text.length <= 120) out.add(text);
  }
  return [...out];
}

/** placeholder="..." values on TextInput and friends. */
function extractPlaceholders(source) {
  const out = new Set();
  const re = /placeholder=\{?["'`]([^"'`]+)["'`]\}?/g;
  let m;
  while ((m = re.exec(source))) out.add(m[1].trim());
  return [...out];
}

/**
 * label="..." props.
 *
 * The auth screens use a custom FloatingLabel wrapper instead of a plain
 * placeholder — the real TextInput sets placeholderTextColor="transparent" and
 * the visible caption is an absolutely positioned <Animated.Text> with
 * pointerEvents="none". So the only human-readable handle on those fields is
 * this prop, and it is what an Appium text selector has to target.
 */
function extractLabels(source) {
  const out = new Set();
  const re = /\blabel=\{?["'`]([^"'`]+)["'`]\}?/g;
  let m;
  while ((m = re.exec(source))) out.add(m[1].trim());
  return [...out];
}

/** navigation.navigate("Target") / navigate("Target", …) targets. */
function extractNavTargets(source) {
  const out = new Set();
  const re = /\bnavigate\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
  let m;
  while ((m = re.exec(source))) out.add(m[1]);
  return [...out];
}

/** Ionicons glyph names — the app's only icon vocabulary. */
function extractIcons(source) {
  const out = new Set();
  const re = /<Ionicons\b[^>]*\bname=\{?["'`]([a-z0-9-]+)["'`]/g;
  let m;
  while ((m = re.exec(source))) out.add(m[1]);
  return [...out];
}

/** Registered <Stack.Screen name="X" component={Y} /> pairs. */
function extractScreenRegistrations(source) {
  const out = [];
  const re = /<(?:Stack|Tab|Drawer)\.Screen\s+name=["'`]([A-Za-z0-9_]+)["'`][^>]*component=\{([A-Za-z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(source))) out.push({ name: m[1], component: m[2] });
  return out;
}

/** Interactive elements: TouchableOpacity / Pressable / Button occurrences. */
function countTouchables(source) {
  return (source.match(/<(TouchableOpacity|Pressable|Button|TouchableHighlight)\b/g) || []).length;
}

function countTextInputs(source) {
  return (source.match(/<TextInput\b/g) || []).length;
}

// ── Model construction ──────────────────────────────────────────────────────

function buildModel() {
  const files = walk(SRC);
  const byPath = new Map();

  for (const file of files) {
    const source = read(file);
    const rel = path.relative(MOBILE_ROOT, file).replace(/\\/g, "/");
    byPath.set(rel, {
      path: rel,
      absolute: file,
      source,
      componentNames: [...source.matchAll(/export\s+(?:default\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
      texts: extractTextLiterals(source),
      placeholders: extractPlaceholders(source),
      labels: extractLabels(source),
      navTargets: extractNavTargets(source),
      icons: extractIcons(source),
      touchables: countTouchables(source),
      textInputs: countTextInputs(source),
      registrations: extractScreenRegistrations(source),
      lines: source.split("\n").length,
    });
  }

  // Screen registry: navigator route name -> the file that defines the component.
  const registry = new Map();
  for (const f of byPath.values()) {
    if (!f.path.includes("/navigation/")) continue;
    for (const reg of f.registrations) {
      // Resolve the component to a screen file by exported function name.
      let target = null;
      for (const cand of byPath.values()) {
        if (cand.componentNames.includes(reg.component)) { target = cand; break; }
      }
      const entry = {
        route: reg.name,
        component: reg.component,
        navigator: path.basename(f.path),
        file: target ? target.path : null,
        screen: target || null,
      };

      // A route name can be registered twice: once on the tab/drawer pointing
      // at a local wrapper (HomeStack, InventoryStack, PatientTabsWithDrawer)
      // and once inside that wrapper pointing at the real screen component.
      // The wrapper is a function local to the navigator file, so it never
      // resolves to a screen file — prefer whichever registration does.
      const existing = registry.get(reg.name);
      if (existing && existing.file && !entry.file) continue;
      registry.set(reg.name, entry);
    }
  }

  const app = fs.existsSync(path.join(MOBILE_ROOT, "app.json"))
    ? JSON.parse(read(path.join(MOBILE_ROOT, "app.json")))
    : {};
  const pkg = JSON.parse(read(path.join(MOBILE_ROOT, "package.json")));

  return {
    root: MOBILE_ROOT,
    files: byPath,
    registry,
    app,
    pkg,

    file(rel) {
      const f = byPath.get(rel);
      if (!f) throw new Error(`No such source file in the mobile app: ${rel}`);
      return f;
    },
    screen(route) {
      const r = registry.get(route);
      if (!r) throw new Error(`Route "${route}" is not registered in any navigator`);
      return r;
    },
    hasRoute(route) {
      return registry.has(route);
    },
    routes() {
      return [...registry.keys()].sort();
    },
    /** Every text literal anywhere in the app (used for global label assertions). */
    allTexts() {
      const out = new Set();
      for (const f of byPath.values()) f.texts.forEach((t) => out.add(t));
      return out;
    },
  };
}

let cached = null;
function getModel() {
  if (!cached) cached = buildModel();
  return cached;
}

module.exports = {
  getModel,
  buildModel,
  MOBILE_ROOT,
  extractTextLiterals,
  extractPlaceholders,
  extractLabels,
  extractNavTargets,
};
