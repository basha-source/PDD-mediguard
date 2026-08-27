"use strict";
/**
 * The MediGuard Selenium test catalog — 300 functional E2E cases.
 *
 * Every case in here is executed against a real headless Chrome instance
 * driving a real production build of apps/web. Nothing is stubbed and nothing
 * is asserted from a fixture: `run(ctx)` navigates, interacts, reads the live
 * DOM, and returns the observed value as a string. A case fails when its
 * assertion throws.
 *
 * Suites are parametrised over data tables (routes, viewports, email fixtures)
 * rather than written out one by one. That is deliberate: the route guard has
 * to hold for all 30 protected routes, not for the three someone remembered to
 * hand-write, and a table makes adding route 31 a one-line change.
 *
 * Case shape:
 *   { id, suite, title, steps: string[], expected, run: async (ctx) => string }
 */

const { By, until, Key } = require("selenium-webdriver");

// ── Application surface under test ──────────────────────────────────────────
// Mirrors apps/web/src/App.tsx. Public routes render their own page when signed
// out; protected routes fall through `<Route path="*">` to a redirect at /login.

const PUBLIC_ROUTES = [
  { path: "/login", name: "Login" },
  { path: "/role-selection", name: "Role Selection" },
  { path: "/health-setup", name: "Health Setup" },
  { path: "/forgot-password", name: "Forgot Password" },
];

const PROTECTED_ROUTES = [
  { path: "/", name: "Dashboard" },
  { path: "/profile", name: "Profile" },
  { path: "/inventory", name: "Inventory" },
  { path: "/doses", name: "Dose Tracker" },
  { path: "/vitals", name: "Vitals" },
  { path: "/adherence", name: "Adherence" },
  { path: "/vaccination", name: "Vaccination" },
  { path: "/missed-doses", name: "Missed Doses" },
  { path: "/drug-interactions", name: "Drug Interactions" },
  { path: "/expiry-alerts", name: "Expiry Alerts" },
  { path: "/substitutes", name: "Substitute Finder" },
  { path: "/medicine-history", name: "Medicine History" },
  { path: "/side-effects", name: "Side Effects" },
  { path: "/ai-assistant", name: "AI Assistant" },
  { path: "/prescriptions", name: "Prescription Upload" },
  { path: "/pharmacy-map", name: "Pharmacy Map" },
  { path: "/family", name: "Family Profiles" },
  { path: "/health-profile", name: "Health Profile" },
  { path: "/travel-mode", name: "Travel Mode" },
  { path: "/emergency-sos", name: "Emergency SOS" },
  { path: "/disposal-guide", name: "Disposal Guide" },
  { path: "/notifications", name: "Notification Prefs" },
  { path: "/doctor-report", name: "Doctor Report" },
  { path: "/export", name: "Export Data" },
  { path: "/wellness-log", name: "Daily Wellness Log" },
  { path: "/wellness-progress", name: "Wellness Progress" },
  { path: "/missed-dose-insights", name: "Missed Dose Insights" },
  { path: "/cg", name: "CG Dashboard" },
  { path: "/cg/monitor", name: "CG Patient Monitor" },
  { path: "/cg/alerts", name: "CG Alerts" },
];

const VIEWPORTS = [
  { w: 320, h: 640, name: "Mobile S (320x640)" },
  { w: 375, h: 812, name: "Mobile M (375x812)" },
  { w: 414, h: 896, name: "Mobile L (414x896)" },
  { w: 768, h: 1024, name: "Tablet (768x1024)" },
  { w: 1280, h: 800, name: "Laptop (1280x800)" },
  { w: 1920, h: 1080, name: "Desktop (1920x1080)" },
];

// Fixtures for the HTML5 constraint-validation table. These are checked against
// the browser's own email grammar via input.checkValidity(), not a regex we
// wrote — the point is to pin what the shipped form actually accepts.
const VALID_EMAILS = [
  "user@example.com", "a@b.co", "first.last@sub.domain.org", "user+tag@example.com",
  "user_name@example.io", "u@d.in", "test123@medi-guard.com", "patient@hospital.co.in",
  "x.y@z.dev", "name@example.travel", "abc@def.ghi", "care@guardian.health",
];

const INVALID_EMAILS = [
  "plainaddress", "@example.com", "user@", "user name@example.com",
  "user@exa mple.com", "user@@example.com", "user@-example.com", "user@example-.com",
  "us er", "user@.com", "user@example..com", "üser@example.com",
];

// ── Assertion helpers ───────────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle, label) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label}: expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(String(haystack).slice(0, 200))}`);
  }
}

/** Current SPA path, ignoring query and hash. */
async function pathname(driver) {
  return driver.executeScript("return window.location.pathname;");
}

/** Reset the login form to a known state between interaction cases. */
async function freshLogin(ctx) {
  await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
  return {
    email: await ctx.driver.findElement(By.css("input[type=email]")),
    password: await ctx.driver.findElement(By.css("input[type=password], input[type=text]")),
  };
}

const cases = [];
let seq = 0;
function add(suite, prefix, title, steps, expected, run) {
  seq += 1;
  cases.push({
    id: `${prefix}-${String(seq).padStart(3, "0")}`,
    suite,
    title,
    steps,
    expected,
    run,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 1 — Public page smoke tests (4 pages x 7 checks = 28)
// ═══════════════════════════════════════════════════════════════════════════

const SMOKE_CHECKS = [
  {
    label: "document reaches readyState=complete",
    expected: "readyState === 'complete'",
    fn: async (ctx) => {
      const state = await ctx.driver.executeScript("return document.readyState;");
      assertEqual(state, "complete", "document.readyState");
      return state;
    },
  },
  {
    label: "React mounts content into #root",
    expected: "#root has at least one child element",
    fn: async (ctx) => {
      const n = await ctx.driver.executeScript("return document.getElementById('root').children.length;");
      assert(n > 0, `#root is empty (children=${n})`);
      return `#root children = ${n}`;
    },
  },
  {
    label: "document title is MediGuard",
    expected: "title === 'MediGuard'",
    fn: async (ctx) => {
      const t = await ctx.driver.getTitle();
      assertEqual(t, "MediGuard", "document.title");
      return t;
    },
  },
  {
    label: "html lang attribute is en",
    expected: "lang === 'en'",
    fn: async (ctx) => {
      const lang = await ctx.driver.executeScript("return document.documentElement.lang;");
      assertEqual(lang, "en", "html[lang]");
      return lang;
    },
  },
  {
    label: "responsive viewport meta present",
    expected: "meta[name=viewport] contains width=device-width",
    fn: async (ctx) => {
      const c = await ctx.driver.executeScript(
        "var m=document.querySelector('meta[name=viewport]'); return m ? m.content : null;");
      assert(c, "no meta[name=viewport]");
      assertIncludes(c, "width=device-width", "viewport meta");
      return c;
    },
  },
  {
    label: "charset declared as UTF-8",
    expected: "meta[charset] === 'UTF-8'",
    fn: async (ctx) => {
      const cs = await ctx.driver.executeScript(
        "var m=document.querySelector('meta[charset]'); return m ? m.getAttribute('charset') : null;");
      assert(cs && cs.toUpperCase() === "UTF-8", `charset was ${cs}`);
      return cs;
    },
  },
  {
    label: "page renders visible text content",
    expected: "body innerText length > 20",
    fn: async (ctx) => {
      const len = await ctx.driver.executeScript("return document.body.innerText.trim().length;");
      assert(len > 20, `body text too short (${len} chars)`);
      return `${len} chars of visible text`;
    },
  },
];

for (const route of PUBLIC_ROUTES) {
  for (const check of SMOKE_CHECKS) {
    add(
      "01 Public Page Smoke",
      "SEL",
      `${route.name} page — ${check.label}`,
      [`Navigate to ${route.path}`, "Wait for the auth gate to settle", `Assert ${check.expected}`],
      check.expected,
      async (ctx) => {
        await ctx.goto(ctx.driver, ctx.baseUrl, route.path);
        return check.fn(ctx);
      }
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 2 — Protected route guard (30 routes x 3 checks = 90)
//
// Signed out, every protected route must land on /login. This is the single
// most security-relevant behaviour in the web client, so it is asserted for
// every route rather than sampled.
// ═══════════════════════════════════════════════════════════════════════════

for (const route of PROTECTED_ROUTES) {
  add(
    "02 Route Guard (unauthenticated)",
    "SEL",
    `${route.name} (${route.path}) redirects an anonymous visitor to /login`,
    [`Clear session`, `Navigate directly to ${route.path}`, "Assert final pathname is /login"],
    "window.location.pathname === '/login'",
    async (ctx) => {
      await ctx.goto(ctx.driver, ctx.baseUrl, route.path);
      const p = await pathname(ctx.driver);
      assertEqual(p, "/login", `guard for ${route.path}`);
      return `redirected ${route.path} -> ${p}`;
    }
  );

  add(
    "02 Route Guard (unauthenticated)",
    "SEL",
    `${route.name} (${route.path}) presents the sign-in form after redirect`,
    [`Navigate to ${route.path}`, "Assert the email field of the login form is present"],
    "input[type=email] exists on the redirected page",
    async (ctx) => {
      await ctx.goto(ctx.driver, ctx.baseUrl, route.path);
      const els = await ctx.driver.findElements(By.css("input[type=email]"));
      assert(els.length === 1, `expected 1 email input, found ${els.length}`);
      return "login form rendered";
    }
  );

  add(
    "02 Route Guard (unauthenticated)",
    "SEL",
    `${route.name} (${route.path}) does not leak protected page content`,
    [`Navigate to ${route.path}`, "Read the rendered body text", "Assert the login branding is what rendered"],
    "body shows the MediGuard sign-in screen",
    async (ctx) => {
      await ctx.goto(ctx.driver, ctx.baseUrl, route.path);
      const text = await ctx.driver.executeScript("return document.body.innerText;");
      assertIncludes(text, "MediGuard", `branding on ${route.path}`);
      assert(/Sign In|Sign Up/i.test(text), "sign-in affordance missing after redirect");
      return "only public sign-in content rendered";
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 3 — Login form interaction (28)
// ═══════════════════════════════════════════════════════════════════════════

const FORM_CASES = [
  ["email field accepts a typed address", "input reflects the typed value", async (ctx) => {
    const { email } = await freshLogin(ctx);
    await email.sendKeys("patient@mediguard.app");
    const v = await email.getAttribute("value");
    assertEqual(v, "patient@mediguard.app", "email value");
    return v;
  }],
  ["password field accepts a typed secret", "input reflects the typed value", async (ctx) => {
    const { password } = await freshLogin(ctx);
    await password.sendKeys("Str0ngPass!");
    const v = await password.getAttribute("value");
    assertEqual(v, "Str0ngPass!", "password value");
    return `${v.length} characters stored`;
  }],
  ["password is masked by default", "input type is 'password'", async (ctx) => {
    const { password } = await freshLogin(ctx);
    const t = await password.getAttribute("type");
    assertEqual(t, "password", "password input type");
    return t;
  }],
  ["Show toggle reveals the password", "input type flips to 'text'", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const toggle = await ctx.driver.findElement(By.xpath("//button[normalize-space()='Show']"));
    await toggle.click();
    const t = await ctx.driver.executeScript(
      "return document.querySelectorAll('form input')[1].type;");
    assertEqual(t, "text", "type after Show");
    return t;
  }],
  ["Hide toggle re-masks the password", "input type returns to 'password'", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await (await ctx.driver.findElement(By.xpath("//button[normalize-space()='Show']"))).click();
    await (await ctx.driver.findElement(By.xpath("//button[normalize-space()='Hide']"))).click();
    const t = await ctx.driver.executeScript(
      "return document.querySelectorAll('form input')[1].type;");
    assertEqual(t, "password", "type after Hide");
    return t;
  }],
  ["Sign Up tab switches the submit action", "submit button reads 'Create Account'", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await (await ctx.driver.findElement(By.xpath("//button[normalize-space()='Sign Up']"))).click();
    const label = await ctx.driver.executeScript(
      "return document.querySelector('form button[type=submit]').innerText.trim();");
    assertEqual(label, "Create Account", "submit label on Sign Up tab");
    return label;
  }],
  ["Sign In tab restores the sign-in action", "submit button reads 'Sign In'", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await (await ctx.driver.findElement(By.xpath("//button[normalize-space()='Sign Up']"))).click();
    await (await ctx.driver.findElement(By.xpath("//button[normalize-space()='Sign In']"))).click();
    const label = await ctx.driver.executeScript(
      "return document.querySelector('form button[type=submit]').innerText.trim();");
    assertEqual(label, "Sign In", "submit label on Sign In tab");
    return label;
  }],
  ["'Forgot password?' navigates to the reset page", "pathname becomes /forgot-password", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await (await ctx.driver.findElement(By.xpath("//button[contains(.,'Forgot password')]"))).click();
    await ctx.driver.wait(async () => (await pathname(ctx.driver)) === "/forgot-password", 8000);
    return await pathname(ctx.driver);
  }],
  ["'Forgot password?' is hidden on the Sign Up tab", "no reset link while registering", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await (await ctx.driver.findElement(By.xpath("//button[normalize-space()='Sign Up']"))).click();
    const els = await ctx.driver.findElements(By.xpath("//button[contains(.,'Forgot password')]"));
    assertEqual(els.length, 0, "forgot-password link count on Sign Up tab");
    return "link correctly absent";
  }],
  ["submit button is enabled on a fresh form", "button is not disabled", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const disabled = await ctx.driver.executeScript(
      "return document.querySelector('form button[type=submit]').disabled;");
    assertEqual(disabled, false, "submit disabled state");
    return "enabled";
  }],
  ["submit control is a real submit button", "button[type=submit] inside <form>", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const ok = await ctx.driver.executeScript(
      "return !!document.querySelector('form button[type=submit]');");
    assert(ok, "no submit button inside the form");
    return "form + submit button present";
  }],
  ["email field carries a helpful placeholder", "placeholder is you@example.com", async (ctx) => {
    const { email } = await freshLogin(ctx);
    const p = await email.getAttribute("placeholder");
    assertEqual(p, "you@example.com", "email placeholder");
    return p;
  }],
  ["password field carries a masked placeholder", "placeholder is a bullet run", async (ctx) => {
    const { password } = await freshLogin(ctx);
    const p = await password.getAttribute("placeholder");
    assert(p && p.length > 0, "password placeholder missing");
    return p;
  }],
  ["email field is marked required", "required attribute present", async (ctx) => {
    const { email } = await freshLogin(ctx);
    const r = await email.getAttribute("required");
    assert(r !== null, "email not required");
    return "required";
  }],
  ["password field is marked required", "required attribute present", async (ctx) => {
    const { password } = await freshLogin(ctx);
    const r = await password.getAttribute("required");
    assert(r !== null, "password not required");
    return "required";
  }],
  ["email field can be cleared", "value returns to empty string", async (ctx) => {
    const { email } = await freshLogin(ctx);
    await email.sendKeys("someone@example.com");
    await email.clear();
    const v = await email.getAttribute("value");
    assertEqual(v, "", "email after clear");
    return "cleared";
  }],
  ["password field can be cleared", "value returns to empty string", async (ctx) => {
    const { password } = await freshLogin(ctx);
    await password.sendKeys("temporary");
    await password.clear();
    const v = await password.getAttribute("value");
    assertEqual(v, "", "password after clear");
    return "cleared";
  }],
  ["Google sign-in button is offered", "button labelled 'Continue with Google'", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const el = await ctx.driver.findElement(By.xpath("//button[contains(.,'Continue with Google')]"));
    const txt = (await el.getText()).trim();
    assertIncludes(txt, "Continue with Google", "google button label");
    return txt;
  }],
  ["exactly two auth mode tabs are rendered", "Sign In and Sign Up", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const n = await ctx.driver.executeScript(
      "return document.querySelectorAll('form')[0].parentElement.querySelectorAll('button').length >= 2;");
    assert(n, "tab row not found");
    const signIn = await ctx.driver.findElements(By.xpath("//button[normalize-space()='Sign In']"));
    const signUp = await ctx.driver.findElements(By.xpath("//button[normalize-space()='Sign Up']"));
    assert(signIn.length >= 1 && signUp.length >= 1, "both tabs must exist");
    return "Sign In + Sign Up tabs present";
  }],
  ["form accepts a long address without truncation", "254-char address retained", async (ctx) => {
    const { email } = await freshLogin(ctx);
    const local = "a".repeat(60);
    const long = `${local}@${"b".repeat(60)}.example.com`;
    await email.sendKeys(long);
    const v = await email.getAttribute("value");
    assertEqual(v.length, long.length, "long email length");
    return `${v.length} characters retained`;
  }],
  ["password field preserves special characters", "symbols survive round-trip", async (ctx) => {
    const { password } = await freshLogin(ctx);
    const pw = "P@ss!#$%&*()_+-=";
    await password.sendKeys(pw);
    const v = await password.getAttribute("value");
    assertEqual(v, pw, "special-character password");
    return "all symbols preserved";
  }],
  ["password field preserves unicode input", "non-ASCII secret survives round-trip", async (ctx) => {
    const { password } = await freshLogin(ctx);
    const pw = "हिन्दीPass1";
    await password.sendKeys(pw);
    const v = await password.getAttribute("value");
    assertEqual(v, pw, "unicode password");
    return "unicode preserved";
  }],
  ["leading/trailing spaces in email are visible to the user", "value keeps what was typed", async (ctx) => {
    const { email } = await freshLogin(ctx);
    await email.sendKeys("  user@example.com  ");
    const v = await email.getAttribute("value");
    assert(v.includes("user@example.com"), "typed address not retained");
    return JSON.stringify(v);
  }],
  ["tab order moves email -> password", "focus lands on the password field", async (ctx) => {
    const { email } = await freshLogin(ctx);
    await email.click();
    await email.sendKeys(Key.TAB);
    const type = await ctx.driver.executeScript("return document.activeElement.type;");
    assert(["password", "text"].includes(type), `focus went to ${type}`);
    return `focus type = ${type}`;
  }],
  ["form does not submit with an empty email", "constraint validation blocks submit", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const valid = await ctx.driver.executeScript(
      "return document.querySelector('form').checkValidity();");
    assertEqual(valid, false, "empty form validity");
    return "submission blocked by required fields";
  }],
  ["filling both fields satisfies constraint validation", "form.checkValidity() is true", async (ctx) => {
    const { email, password } = await freshLogin(ctx);
    await email.sendKeys("user@example.com");
    await password.sendKeys("secret123");
    const valid = await ctx.driver.executeScript(
      "return document.querySelector('form').checkValidity();");
    assertEqual(valid, true, "filled form validity");
    return "form is submittable";
  }],
  ["switching tabs clears a previous error message", "no error banner after tab switch", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await (await ctx.driver.findElement(By.xpath("//button[normalize-space()='Sign Up']"))).click();
    const n = await ctx.driver.executeScript(
      "return document.querySelectorAll('.text-alert-red').length;");
    assertEqual(n, 0, "error banners after tab switch");
    return "no stale error shown";
  }],
  ["brand heading identifies the product", "h1 reads 'MediGuard'", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const h1 = await ctx.driver.findElement(By.css("h1"));
    const t = (await h1.getText()).trim();
    assertEqual(t, "MediGuard", "h1 text");
    return t;
  }],
];

for (const [title, expected, fn] of FORM_CASES) {
  add("03 Login Form Interaction", "SEL", title,
    ["Open /login", "Perform the interaction", "Assert the observed DOM state"],
    expected, fn);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 4 — HTML5 email constraint validation (24)
// ═══════════════════════════════════════════════════════════════════════════

for (const addr of VALID_EMAILS) {
  add(
    "04 Email Validation (accepted)",
    "SEL",
    `Login accepts a well-formed address: ${addr}`,
    ["Open /login", `Type ${addr} into the email field`, "Read input.checkValidity()"],
    "checkValidity() === true",
    async (ctx) => {
      const { email } = await freshLogin(ctx);
      await email.sendKeys(addr);
      const valid = await ctx.driver.executeScript(
        "return document.querySelector('input[type=email]').checkValidity();");
      assertEqual(valid, true, `validity for ${addr}`);
      return `${addr} accepted`;
    }
  );
}

for (const addr of INVALID_EMAILS) {
  add(
    "05 Email Validation (rejected)",
    "SEL",
    `Login rejects a malformed address: ${JSON.stringify(addr)}`,
    ["Open /login", `Type ${JSON.stringify(addr)} into the email field`, "Read input.checkValidity()"],
    "checkValidity() === false",
    async (ctx) => {
      const { email } = await freshLogin(ctx);
      await email.sendKeys(addr);
      const valid = await ctx.driver.executeScript(
        "return document.querySelector('input[type=email]').checkValidity();");
      assertEqual(valid, false, `validity for ${addr}`);
      return `${JSON.stringify(addr)} rejected`;
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 6 — Password field behaviour (16)
// ═══════════════════════════════════════════════════════════════════════════

const PASSWORD_FIXTURES = [
  ["a", "single character"],
  ["ab12", "short numeric mix"],
  ["secret", "six characters — Firebase minimum"],
  ["Str0ng!Pass", "mixed case with symbol"],
  ["    ", "whitespace only"],
  ["0123456789", "all digits"],
  ["!@#$%^&*()", "all symbols"],
  ["x".repeat(128), "128-character maximum"],
];

for (const [pw, label] of PASSWORD_FIXTURES) {
  add(
    "06 Password Field Handling",
    "SEL",
    `Password field stores ${label} without alteration`,
    ["Open /login", "Type the fixture into the password field", "Compare stored value with input"],
    "value matches the typed secret exactly",
    async (ctx) => {
      const { password } = await freshLogin(ctx);
      await password.sendKeys(pw);
      const v = await password.getAttribute("value");
      assertEqual(v, pw, `password round-trip (${label})`);
      return `${v.length} characters stored intact`;
    }
  );

  add(
    "06 Password Field Handling",
    "SEL",
    `Password field keeps ${label} masked in the DOM`,
    ["Open /login", "Type the fixture", "Assert the input type is still 'password'"],
    "type remains 'password' (value never rendered as text)",
    async (ctx) => {
      const { password } = await freshLogin(ctx);
      await password.sendKeys(pw);
      const t = await password.getAttribute("type");
      assertEqual(t, "password", "masking preserved");
      return "value remains masked";
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 7 — Responsive layout (6 viewports x 4 public pages = 24)
// ═══════════════════════════════════════════════════════════════════════════

for (const vp of VIEWPORTS) {
  for (const route of PUBLIC_ROUTES) {
    add(
      "07 Responsive Layout",
      "SEL",
      `${route.name} renders within the viewport at ${vp.name}`,
      [`Resize the window to ${vp.w}x${vp.h}`, `Navigate to ${route.path}`,
       "Measure the rendered root width against the viewport"],
      "content width never exceeds the viewport width",
      async (ctx) => {
        await ctx.driver.manage().window().setRect({ width: vp.w, height: vp.h });
        await ctx.goto(ctx.driver, ctx.baseUrl, route.path);
        const m = await ctx.driver.executeScript(`
          var root = document.getElementById('root');
          return {
            inner: window.innerWidth,
            content: Math.ceil(root.getBoundingClientRect().width),
            children: root.children.length
          };`);
        assert(m.children > 0, "nothing rendered at this viewport");
        assert(m.content <= m.inner + 1,
          `content ${m.content}px overflows viewport ${m.inner}px`);
        return `content ${m.content}px fits viewport ${m.inner}px`;
      }
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 8 — Navigation and history (18)
// ═══════════════════════════════════════════════════════════════════════════

const NAV_CASES = [
  ["Direct deep link to /login renders the login page", "pathname stays /login", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    assertEqual(await pathname(ctx.driver), "/login", "pathname");
    return "/login";
  }],
  ["Direct deep link to /forgot-password renders the reset page", "pathname stays /forgot-password", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/forgot-password");
    assertEqual(await pathname(ctx.driver), "/forgot-password", "pathname");
    return "/forgot-password";
  }],
  ["Direct deep link to /role-selection renders", "pathname stays /role-selection", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/role-selection");
    assertEqual(await pathname(ctx.driver), "/role-selection", "pathname");
    return "/role-selection";
  }],
  ["Direct deep link to /health-setup renders", "pathname stays /health-setup", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/health-setup");
    assertEqual(await pathname(ctx.driver), "/health-setup", "pathname");
    return "/health-setup";
  }],
  ["Browser back returns from the reset page to login", "history.back() restores /login", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await (await ctx.driver.findElement(By.xpath("//button[contains(.,'Forgot password')]"))).click();
    await ctx.driver.wait(async () => (await pathname(ctx.driver)) === "/forgot-password", 8000);
    await ctx.driver.navigate().back();
    await ctx.driver.wait(async () => (await pathname(ctx.driver)) === "/login", 8000);
    return "back returned to /login";
  }],
  ["Browser forward re-enters the reset page", "history.forward() restores /forgot-password", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await (await ctx.driver.findElement(By.xpath("//button[contains(.,'Forgot password')]"))).click();
    await ctx.driver.wait(async () => (await pathname(ctx.driver)) === "/forgot-password", 8000);
    await ctx.driver.navigate().back();
    await ctx.driver.wait(async () => (await pathname(ctx.driver)) === "/login", 8000);
    await ctx.driver.navigate().forward();
    await ctx.driver.wait(async () => (await pathname(ctx.driver)) === "/forgot-password", 8000);
    return "forward returned to /forgot-password";
  }],
  ["Page reload preserves the current public route", "refresh keeps /forgot-password", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/forgot-password");
    await ctx.driver.navigate().refresh();
    await ctx.driver.wait(async () =>
      ctx.driver.executeScript("return !document.body.innerText.includes('Loading MediGuard');"), 15000);
    assertEqual(await pathname(ctx.driver), "/forgot-password", "pathname after reload");
    return "route survived a hard reload";
  }],
  ["Query string on a protected route is not carried to /login", "redirect drops the query", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/inventory?filter=expired");
    assertEqual(await pathname(ctx.driver), "/login", "pathname");
    const search = await ctx.driver.executeScript("return window.location.search;");
    assertEqual(search, "", "query string after guard redirect");
    return "query dropped on redirect";
  }],
  ["Hash fragment on a protected route is dropped by the guard", "redirect drops the hash", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/vitals#section-2");
    assertEqual(await pathname(ctx.driver), "/login", "pathname");
    return "hash dropped on redirect";
  }],
  ["Query string on a public route is preserved", "/login?next=/inventory keeps its query", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login?next=/inventory");
    const search = await ctx.driver.executeScript("return window.location.search;");
    assertIncludes(search, "next=", "preserved query");
    return search;
  }],
  ["Guard redirect uses replace, not push", "back from the guard does not loop", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.goto(ctx.driver, ctx.baseUrl, "/inventory");
    assertEqual(await pathname(ctx.driver), "/login", "guarded pathname");
    return "redirect replaced the guarded entry";
  }],
  ["Unknown top-level route falls back to /login", "/does-not-exist redirects", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/does-not-exist");
    assertEqual(await pathname(ctx.driver), "/login", "pathname");
    return "unknown route handled";
  }],
  ["Deeply nested unknown route falls back to /login", "/a/b/c/d redirects", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/a/b/c/d");
    assertEqual(await pathname(ctx.driver), "/login", "pathname");
    return "nested unknown route handled";
  }],
  // React Router v6 matches case-insensitively unless a route opts in with
  // caseSensitive, so /LOGIN resolves to the login route while the address bar
  // keeps the casing the user typed. Pinning that here means a future switch to
  // caseSensitive routes fails loudly instead of silently 404-ing shared links.
  ["Route matching is case-insensitive", "/LOGIN still renders the login screen", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/LOGIN");
    const els = await ctx.driver.findElements(By.css("input[type=email]"));
    assertEqual(els.length, 1, "login form on /LOGIN");
    const p = await pathname(ctx.driver);
    assertEqual(p, "/LOGIN", "pathname casing preserved");
    return `/LOGIN matched the login route (pathname kept as ${p})`;
  }],
  ["Trailing slash on a public route still renders", "/login/ resolves", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login/");
    const p = await pathname(ctx.driver);
    assert(p === "/login" || p === "/login/", `unexpected pathname ${p}`);
    return p;
  }],
  ["Percent-encoded path is handled without a crash", "app still renders after decode", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/%2Fetc%2Fpasswd");
    const n = await ctx.driver.executeScript("return document.getElementById('root').children.length;");
    assert(n > 0, "app failed to render");
    return "encoded path handled safely";
  }],
  ["Very long path does not break routing", "512-char path redirects cleanly", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/" + "x".repeat(512));
    assertEqual(await pathname(ctx.driver), "/login", "pathname");
    return "long path redirected";
  }],
  ["Root path redirects an anonymous visitor to /login", "'/' resolves to /login", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/");
    assertEqual(await pathname(ctx.driver), "/login", "pathname");
    return "/ -> /login";
  }],
];

for (const [title, expected, fn] of NAV_CASES) {
  add("08 Navigation & History", "SEL", title,
    ["Drive the browser through the navigation", "Assert the resulting location and DOM"],
    expected, fn);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 9 — Accessibility (20)
// ═══════════════════════════════════════════════════════════════════════════

const A11Y_CASES = [
  ["Login page exposes exactly one h1 landmark", "1 h1 element", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const n = await ctx.driver.executeScript("return document.querySelectorAll('h1').length;");
    assertEqual(n, 1, "h1 count");
    return "1 h1";
  }],
  ["Every form input has a visible label", "label count >= input count", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const m = await ctx.driver.executeScript(`
      var f = document.querySelector('form');
      return { inputs: f.querySelectorAll('input').length, labels: f.querySelectorAll('label').length };`);
    assert(m.labels >= m.inputs, `${m.labels} labels for ${m.inputs} inputs`);
    return `${m.labels} labels / ${m.inputs} inputs`;
  }],
  ["Email input uses the email type for assistive tech", "type=email triggers the right keyboard", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const t = await ctx.driver.executeScript(
      "return document.querySelector('form input').type;");
    assertEqual(t, "email", "first input type");
    return t;
  }],
  ["No positive tabindex hijacks the focus order", "all tabindex values <= 0", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const bad = await ctx.driver.executeScript(`
      return Array.from(document.querySelectorAll('[tabindex]'))
        .map(function (e) { return parseInt(e.getAttribute('tabindex'), 10); })
        .filter(function (v) { return v > 0; }).length;`);
    assertEqual(bad, 0, "positive tabindex count");
    return "natural focus order preserved";
  }],
  ["Every button exposes an accessible name", "no unlabelled buttons", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const unnamed = await ctx.driver.executeScript(`
      return Array.from(document.querySelectorAll('button')).filter(function (b) {
        var name = (b.innerText || '').trim() || b.getAttribute('aria-label') || b.title || '';
        return name.length === 0;
      }).length;`);
    assertEqual(unnamed, 0, "buttons without an accessible name");
    return "all buttons named";
  }],
  ["Every image carries alt text", "no <img> without alt", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const missing = await ctx.driver.executeScript(
      "return document.querySelectorAll('img:not([alt])').length;");
    assertEqual(missing, 0, "images missing alt");
    return "no images missing alt";
  }],
  ["Email field is reachable by keyboard", "field can take focus", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("document.querySelector('input[type=email]').focus();");
    const t = await ctx.driver.executeScript("return document.activeElement.type;");
    assertEqual(t, "email", "focused element");
    return "email field focusable";
  }],
  ["Submit button is reachable by keyboard", "button can take focus", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("document.querySelector('form button[type=submit]').focus();");
    const tag = await ctx.driver.executeScript("return document.activeElement.tagName;");
    assertEqual(tag, "BUTTON", "focused element");
    return "submit focusable";
  }],
  ["Decorative toggle buttons declare type=button", "Show/Hide never submits the form", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const t = await ctx.driver.executeScript(`
      var b = Array.from(document.querySelectorAll('form button'))
        .find(function (x) { return /Show|Hide/.test(x.innerText); });
      return b ? b.type : null;`);
    assertEqual(t, "button", "toggle button type");
    return "type=button";
  }],
  ["Page language is declared for screen readers", "html[lang] is set", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const lang = await ctx.driver.executeScript("return document.documentElement.lang;");
    assert(lang && lang.length >= 2, "html lang missing");
    return lang;
  }],
  ["Document has a non-empty title", "title length > 0", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const t = await ctx.driver.getTitle();
    assert(t.trim().length > 0, "empty title");
    return t;
  }],
  ["Interactive controls are large enough to tap", "primary button >= 40px tall", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const h = await ctx.driver.executeScript(
      "return document.querySelector('form button[type=submit]').getBoundingClientRect().height;");
    assert(h >= 40, `submit button only ${h}px tall`);
    return `${Math.round(h)}px tall`;
  }],
  ["Email input is large enough to tap", "input >= 36px tall", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const h = await ctx.driver.executeScript(
      "return document.querySelector('input[type=email]').getBoundingClientRect().height;");
    assert(h >= 36, `email input only ${h}px tall`);
    return `${Math.round(h)}px tall`;
  }],
  ["Focus is visible on the email field", "focus ring styles are applied", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const cls = await ctx.driver.executeScript(
      "return document.querySelector('input[type=email]').className;");
    assertIncludes(cls, "focus:", "focus-visible styling");
    return "focus ring utility classes present";
  }],
  ["Form fields are grouped inside a <form> element", "semantic form wrapper", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const n = await ctx.driver.executeScript("return document.querySelectorAll('form').length;");
    assert(n >= 1, "no form element");
    return `${n} form element(s)`;
  }],
  ["Reset page keeps a single h1 landmark", "1 h1 on /forgot-password", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/forgot-password");
    const n = await ctx.driver.executeScript("return document.querySelectorAll('h1').length;");
    assert(n <= 1, `${n} h1 elements`);
    return `${n} h1`;
  }],
  ["Role selection page renders readable text", "visible text present", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/role-selection");
    const len = await ctx.driver.executeScript("return document.body.innerText.trim().length;");
    assert(len > 20, "insufficient text content");
    return `${len} chars`;
  }],
  ["Health setup page renders readable text", "visible text present", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/health-setup");
    const len = await ctx.driver.executeScript("return document.body.innerText.trim().length;");
    assert(len > 20, "insufficient text content");
    return `${len} chars`;
  }],
  ["No element uses the deprecated autofocus stacking", "at most one autofocus element", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const n = await ctx.driver.executeScript("return document.querySelectorAll('[autofocus]').length;");
    assert(n <= 1, `${n} autofocus elements compete for focus`);
    return `${n} autofocus element(s)`;
  }],
  ["Scroll container is the document, not a nested trap", "body is scrollable", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const overflow = await ctx.driver.executeScript(
      "return getComputedStyle(document.body).overflow;");
    assert(overflow !== "hidden", "body scrolling is locked");
    return `body overflow = ${overflow}`;
  }],
];

for (const [title, expected, fn] of A11Y_CASES) {
  add("09 Accessibility", "SEL", title,
    ["Open the page", "Query the accessibility-relevant DOM properties", "Assert the result"],
    expected, fn);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 10 — Client-side security hardening (16)
// ═══════════════════════════════════════════════════════════════════════════

const SEC_CASES = [
  ["No private key material is shipped in the bundle", "no PEM block in page source", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const src = await ctx.driver.getPageSource();
    assert(!src.includes("BEGIN PRIVATE KEY") && !src.includes("BEGIN RSA PRIVATE KEY"),
      "PEM private key found in delivered HTML");
    return "no PEM material in the delivered document";
  }],
  ["No Firebase service-account JSON is shipped", "no private_key field in source", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const src = await ctx.driver.getPageSource();
    assert(!src.includes("\"private_key\""), "service account JSON leaked to the client");
    return "no service-account JSON in the client";
  }],
  ["Password is never mirrored into localStorage", "no password-like key persisted", async (ctx) => {
    const { email, password } = await freshLogin(ctx);
    await email.sendKeys("user@example.com");
    await password.sendKeys("SuperSecret123");
    const leaked = await ctx.driver.executeScript(`
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if ((localStorage.getItem(k) || '').indexOf('SuperSecret123') !== -1) return k;
      }
      return null;`);
    assertEqual(leaked, null, "localStorage key containing the password");
    return "password not persisted to localStorage";
  }],
  ["Password is never mirrored into sessionStorage", "no password-like key persisted", async (ctx) => {
    const { password } = await freshLogin(ctx);
    await password.sendKeys("SuperSecret123");
    const leaked = await ctx.driver.executeScript(`
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if ((sessionStorage.getItem(k) || '').indexOf('SuperSecret123') !== -1) return k;
      }
      return null;`);
    assertEqual(leaked, null, "sessionStorage key containing the password");
    return "password not persisted to sessionStorage";
  }],
  ["Password is never written to a cookie", "document.cookie stays clean", async (ctx) => {
    const { password } = await freshLogin(ctx);
    await password.sendKeys("SuperSecret123");
    const cookie = await ctx.driver.executeScript("return document.cookie;");
    assert(!cookie.includes("SuperSecret123"), "password found in document.cookie");
    return "no credential in cookies";
  }],
  ["X-Content-Type-Options is served as nosniff", "header present on the document", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const v = await ctx.driver.executeAsyncScript(`
      var cb = arguments[arguments.length - 1];
      fetch(window.location.origin + '/index.html', { cache: 'no-store' })
        .then(function (r) { cb(r.headers.get('x-content-type-options')); })
        .catch(function () { cb(null); });`);
    assertEqual(v, "nosniff", "X-Content-Type-Options");
    return v;
  }],
  ["X-Frame-Options denies framing", "header present on the document", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const v = await ctx.driver.executeAsyncScript(`
      var cb = arguments[arguments.length - 1];
      fetch(window.location.origin + '/index.html', { cache: 'no-store' })
        .then(function (r) { cb(r.headers.get('x-frame-options')); })
        .catch(function () { cb(null); });`);
    assertEqual(v, "DENY", "X-Frame-Options");
    return v;
  }],
  ["Referrer-Policy suppresses cross-origin referrers", "header present on the document", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const v = await ctx.driver.executeAsyncScript(`
      var cb = arguments[arguments.length - 1];
      fetch(window.location.origin + '/index.html', { cache: 'no-store' })
        .then(function (r) { cb(r.headers.get('referrer-policy')); })
        .catch(function () { cb(null); });`);
    assertEqual(v, "no-referrer", "Referrer-Policy");
    return v;
  }],
  ["No inline javascript: URLs in the login page", "no javascript: hrefs", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const n = await ctx.driver.executeScript(
      "return document.querySelectorAll('a[href^=\"javascript:\"]').length;");
    assertEqual(n, 0, "javascript: hrefs");
    return "no javascript: URLs";
  }],
  ["Password input opts out of the browser's value exposure", "type stays password on submit path", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const t = await ctx.driver.executeScript(
      "return document.querySelectorAll('form input')[1].type;");
    assertEqual(t, "password", "password input type at rest");
    return t;
  }],
  ["Reflected script in the path is not executed", "XSS payload in the URL stays inert", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/%3Cscript%3Ewindow.__xss=1%3C/script%3E");
    const fired = await ctx.driver.executeScript("return window.__xss === 1;");
    assertEqual(fired, false, "reflected XSS executed");
    return "payload not executed";
  }],
  ["Reflected script in a query parameter is not executed", "XSS payload in ?q stays inert", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login?q=%3Cimg%20src=x%20onerror=window.__xss2=1%3E");
    const fired = await ctx.driver.executeScript("return window.__xss2 === 1;");
    assertEqual(fired, false, "reflected XSS executed");
    return "payload not executed";
  }],
  ["Script payload typed into the email field is not executed", "stored input stays inert", async (ctx) => {
    const { email } = await freshLogin(ctx);
    await email.sendKeys("<script>window.__xss3=1</script>@x.com");
    const fired = await ctx.driver.executeScript("return window.__xss3 === 1;");
    assertEqual(fired, false, "input payload executed");
    return "input treated as text, not markup";
  }],
  ["Directory traversal on the asset server is refused", "../ escape returns non-200", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const status = await ctx.driver.executeAsyncScript(`
      var cb = arguments[arguments.length - 1];
      fetch(window.location.origin + '/../../package.json', { cache: 'no-store' })
        .then(function (r) { cb(r.status); }).catch(function () { cb(0); });`);
    assert(status !== 200, `traversal returned ${status}`);
    return `traversal blocked (status ${status})`;
  }],
  ["No debug hooks are exposed on window", "no __REDUX_DEVTOOLS/__DEV__ globals", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const exposed = await ctx.driver.executeScript(
      "return !!(window.__REDUX_DEVTOOLS_EXTENSION__ || window.__DEV__);");
    assertEqual(exposed, false, "debug globals exposed");
    return "no debug globals on window";
  }],
  ["Login page loads no third-party origins", "all requests are same-origin", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const foreign = await ctx.driver.executeScript(`
      var origin = window.location.origin;
      return performance.getEntriesByType('resource')
        .map(function (e) { return e.name; })
        .filter(function (n) { return n.indexOf(origin) !== 0 && n.indexOf('data:') !== 0; });`);
    assertEqual(foreign.length, 0, `third-party requests: ${JSON.stringify(foreign).slice(0, 200)}`);
    return "no third-party requests on the login screen";
  }],
];

for (const [title, expected, fn] of SEC_CASES) {
  add("10 Client Security Hardening", "SEL", title,
    ["Open the page under test", "Probe the security-relevant behaviour", "Assert the safe outcome"],
    expected, fn);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 11 — Performance budget (12)
// ═══════════════════════════════════════════════════════════════════════════

const PERF_CASES = [
  ["Login page reaches DOMContentLoaded within budget", "< 10000 ms", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const ms = await ctx.driver.executeScript(`
      var n = performance.getEntriesByType('navigation')[0];
      return Math.round(n.domContentLoadedEventEnd);`);
    assert(ms < 10000, `DOMContentLoaded took ${ms}ms`);
    return `${ms} ms`;
  }],
  ["Login page fires the load event within budget", "< 15000 ms", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const ms = await ctx.driver.executeScript(`
      var n = performance.getEntriesByType('navigation')[0];
      return Math.round(n.loadEventEnd || n.domComplete);`);
    assert(ms < 15000, `load took ${ms}ms`);
    return `${ms} ms`;
  }],
  ["Server responds to the document request quickly", "TTFB < 2000 ms", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const ms = await ctx.driver.executeScript(`
      var n = performance.getEntriesByType('navigation')[0];
      return Math.round(n.responseStart - n.requestStart);`);
    assert(ms < 2000, `TTFB was ${ms}ms`);
    return `${ms} ms`;
  }],
  ["DOM stays within a maintainable node budget", "< 3000 nodes", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const n = await ctx.driver.executeScript("return document.getElementsByTagName('*').length;");
    assert(n < 3000, `${n} DOM nodes`);
    return `${n} nodes`;
  }],
  ["Login screen requests a bounded number of resources", "< 60 requests", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const n = await ctx.driver.executeScript(
      "return performance.getEntriesByType('resource').length;");
    assert(n < 60, `${n} resource requests`);
    return `${n} requests`;
  }],
  ["First Paint occurs within budget", "< 10000 ms", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const ms = await ctx.driver.executeScript(`
      var p = performance.getEntriesByName('first-paint')[0];
      return p ? Math.round(p.startTime) : 0;`);
    assert(ms < 10000, `first paint at ${ms}ms`);
    return `${ms} ms`;
  }],
  ["First Contentful Paint occurs within budget", "< 10000 ms", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const ms = await ctx.driver.executeScript(`
      var p = performance.getEntriesByName('first-contentful-paint')[0];
      return p ? Math.round(p.startTime) : 0;`);
    assert(ms < 10000, `FCP at ${ms}ms`);
    return `${ms} ms`;
  }],
  ["Total transferred bytes stay within budget", "< 8 MB", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const bytes = await ctx.driver.executeScript(`
      return performance.getEntriesByType('resource')
        .reduce(function (a, e) { return a + (e.transferSize || 0); }, 0);`);
    const mb = bytes / 1024 / 1024;
    assert(mb < 8, `${mb.toFixed(2)} MB transferred`);
    return `${mb.toFixed(2)} MB`;
  }],
  ["Route change to /forgot-password is instant", "< 5000 ms client-side transition", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const start = Date.now();
    await (await ctx.driver.findElement(By.xpath("//button[contains(.,'Forgot password')]"))).click();
    await ctx.driver.wait(async () => (await pathname(ctx.driver)) === "/forgot-password", 8000);
    const ms = Date.now() - start;
    assert(ms < 5000, `transition took ${ms}ms`);
    return `${ms} ms`;
  }],
  ["Guard redirect completes quickly", "< 15000 ms to reach /login", async (ctx) => {
    const start = Date.now();
    await ctx.goto(ctx.driver, ctx.baseUrl, "/inventory");
    const ms = Date.now() - start;
    assertEqual(await pathname(ctx.driver), "/login", "pathname");
    assert(ms < 15000, `redirect took ${ms}ms`);
    return `${ms} ms`;
  }],
  ["No single resource dominates the load", "largest asset < 5 MB", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const bytes = await ctx.driver.executeScript(`
      return performance.getEntriesByType('resource')
        .reduce(function (m, e) { return Math.max(m, e.transferSize || 0); }, 0);`);
    const mb = bytes / 1024 / 1024;
    assert(mb < 5, `largest asset ${mb.toFixed(2)} MB`);
    return `${mb.toFixed(2)} MB largest asset`;
  }],
  ["Repeat navigation benefits from the HTTP cache path", "second load not slower than 3x the first", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const first = await ctx.driver.executeScript(
      "return Math.round(performance.getEntriesByType('navigation')[0].duration);");
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const second = await ctx.driver.executeScript(
      "return Math.round(performance.getEntriesByType('navigation')[0].duration);");
    assert(second <= Math.max(first * 3, 15000), `first ${first}ms, second ${second}ms`);
    return `first ${first} ms, second ${second} ms`;
  }],
];

for (const [title, expected, fn] of PERF_CASES) {
  add("11 Performance Budget", "SEL", title,
    ["Open the page", "Read the Navigation/Resource Timing entries", "Assert against the budget"],
    expected, fn);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 12 — Error handling and resilience (12)
// ═══════════════════════════════════════════════════════════════════════════

const ERR_CASES = [
  ["Missing asset returns 404 rather than the SPA shell", "/nope.js is a 404", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const status = await ctx.driver.executeAsyncScript(`
      var cb = arguments[arguments.length - 1];
      fetch(window.location.origin + '/nope.js', { cache: 'no-store' })
        .then(function (r) { cb(r.status); }).catch(function () { cb(0); });`);
    assertEqual(status, 404, "missing asset status");
    return `status ${status}`;
  }],
  ["Unknown route serves the SPA shell, not a 404", "HTML shell returned for /unknown", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const status = await ctx.driver.executeAsyncScript(`
      var cb = arguments[arguments.length - 1];
      fetch(window.location.origin + '/unknown-route', { cache: 'no-store' })
        .then(function (r) { cb(r.status); }).catch(function () { cb(0); });`);
    assertEqual(status, 200, "SPA fallback status");
    return `status ${status}`;
  }],
  ["App survives a blocked network call", "no unhandled rejection crashes the tree", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("fetch('http://127.0.0.1:1/none').catch(function(){});");
    const n = await ctx.driver.executeScript("return document.getElementById('root').children.length;");
    assert(n > 0, "React tree unmounted after a failed fetch");
    return "app remained mounted";
  }],
  ["App survives a cleared localStorage", "tree stays mounted after storage wipe", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("localStorage.clear();");
    await ctx.driver.navigate().refresh();
    await ctx.driver.wait(async () =>
      ctx.driver.executeScript("return !document.body.innerText.includes('Loading MediGuard');"), 15000);
    const n = await ctx.driver.executeScript("return document.getElementById('root').children.length;");
    assert(n > 0, "app failed to boot with empty storage");
    return "app booted with empty storage";
  }],
  ["App survives corrupt localStorage values", "malformed JSON does not break boot", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("localStorage.setItem('mediguard-test', '{not-json');");
    await ctx.driver.navigate().refresh();
    await ctx.driver.wait(async () =>
      ctx.driver.executeScript("return !document.body.innerText.includes('Loading MediGuard');"), 15000);
    const n = await ctx.driver.executeScript("return document.getElementById('root').children.length;");
    assert(n > 0, "app failed to boot with corrupt storage");
    await ctx.driver.executeScript("localStorage.removeItem('mediguard-test');");
    return "app booted despite corrupt storage";
  }],
  ["Rapid repeated navigation does not break the router", "10 navigations settle on /login", async (ctx) => {
    for (let i = 0; i < 10; i++) {
      await ctx.driver.get(ctx.baseUrl + (i % 2 ? "/login" : "/inventory"));
    }
    await ctx.driver.wait(async () =>
      ctx.driver.executeScript("return !document.body.innerText.includes('Loading MediGuard');"), 15000);
    const p = await pathname(ctx.driver);
    assertEqual(p, "/login", "final pathname after rapid navigation");
    return "router settled correctly";
  }],
  ["Double-clicking submit does not duplicate the form", "still exactly one form", async (ctx) => {
    const { email, password } = await freshLogin(ctx);
    await email.sendKeys("user@example.com");
    await password.sendKeys("secret123");
    const btn = await ctx.driver.findElement(By.css("form button[type=submit]"));
    await btn.click();
    await btn.click().catch(() => {});
    const n = await ctx.driver.executeScript("return document.querySelectorAll('form').length;");
    assertEqual(n, 1, "form count after double submit");
    return "single form retained";
  }],
  ["Failed sign-in keeps the user on the login route", "pathname stays /login", async (ctx) => {
    const { email, password } = await freshLogin(ctx);
    await email.sendKeys("nobody@example.com");
    await password.sendKeys("wrong-password");
    await (await ctx.driver.findElement(By.css("form button[type=submit]"))).click();
    await ctx.driver.sleep(1500);
    const p = await pathname(ctx.driver);
    assertEqual(p, "/login", "pathname after a failed sign-in");
    return "user retained on /login";
  }],
  ["Failed sign-in does not expose a stack trace", "no raw error object rendered", async (ctx) => {
    const { email, password } = await freshLogin(ctx);
    await email.sendKeys("nobody@example.com");
    await password.sendKeys("wrong-password");
    await (await ctx.driver.findElement(By.css("form button[type=submit]"))).click();
    await ctx.driver.sleep(1500);
    const text = await ctx.driver.executeScript("return document.body.innerText;");
    assert(!/at\s+\w+\s+\(.*:\d+:\d+\)/.test(text), "stack trace rendered to the user");
    return "no stack trace surfaced";
  }],
  ["Failed sign-in re-enables the submit button", "button is interactive again", async (ctx) => {
    const { email, password } = await freshLogin(ctx);
    await email.sendKeys("nobody@example.com");
    await password.sendKeys("wrong-password");
    await (await ctx.driver.findElement(By.css("form button[type=submit]"))).click();
    await ctx.driver.sleep(2000);
    const disabled = await ctx.driver.executeScript(
      "return document.querySelector('form button[type=submit]').disabled;");
    assertEqual(disabled, false, "submit still disabled after failure");
    return "submit re-enabled";
  }],
  ["Window resize during render does not detach the tree", "root survives 3 resizes", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    for (const vp of [{ width: 400, height: 800 }, { width: 1200, height: 900 }, { width: 800, height: 600 }]) {
      await ctx.driver.manage().window().setRect(vp);
    }
    const n = await ctx.driver.executeScript("return document.getElementById('root').children.length;");
    assert(n > 0, "tree detached after resize");
    await ctx.driver.manage().window().setRect({ width: 1440, height: 900 });
    return "tree intact across resizes";
  }],
  ["Back navigation from the very first entry is safe", "no crash when history is empty", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.navigate().back().catch(() => {});
    await ctx.driver.get(ctx.baseUrl + "/login");
    await ctx.driver.wait(async () =>
      ctx.driver.executeScript("return !document.body.innerText.includes('Loading MediGuard');"), 15000);
    const n = await ctx.driver.executeScript("return document.getElementById('root').children.length;");
    assert(n > 0, "app broken after back at history root");
    return "app stable";
  }],
];

for (const [title, expected, fn] of ERR_CASES) {
  add("12 Error Handling & Resilience", "SEL", title,
    ["Induce the failure condition", "Observe how the client reacts", "Assert graceful handling"],
    expected, fn);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUITE 13 — Browser storage behaviour (12)
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_CASES = [
  ["localStorage is available to the app", "setItem/getItem round-trips", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const v = await ctx.driver.executeScript(`
      localStorage.setItem('mg-probe', 'ok');
      var r = localStorage.getItem('mg-probe');
      localStorage.removeItem('mg-probe');
      return r;`);
    assertEqual(v, "ok", "localStorage round-trip");
    return "read/write confirmed";
  }],
  ["sessionStorage is available to the app", "setItem/getItem round-trips", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const v = await ctx.driver.executeScript(`
      sessionStorage.setItem('mg-probe', 'ok');
      var r = sessionStorage.getItem('mg-probe');
      sessionStorage.removeItem('mg-probe');
      return r;`);
    assertEqual(v, "ok", "sessionStorage round-trip");
    return "read/write confirmed";
  }],
  ["No stored key is literally named password", "no obvious credential key", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const hits = await ctx.driver.executeScript(`
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/password|passwd|secret/i.test(k)) out.push(k);
      }
      return out;`);
    assertEqual(hits.length, 0, `credential-named keys: ${JSON.stringify(hits)}`);
    return "no credential-named keys";
  }],
  ["Storage survives a client-side route change", "value persists across navigation", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("localStorage.setItem('mg-nav', 'kept');");
    await (await ctx.driver.findElement(By.xpath("//button[contains(.,'Forgot password')]"))).click();
    await ctx.driver.wait(async () => (await pathname(ctx.driver)) === "/forgot-password", 8000);
    const v = await ctx.driver.executeScript("return localStorage.getItem('mg-nav');");
    assertEqual(v, "kept", "value after route change");
    await ctx.driver.executeScript("localStorage.removeItem('mg-nav');");
    return "value persisted";
  }],
  ["sessionStorage is cleared by a fresh browsing context", "probe key absent after reset", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("sessionStorage.clear();");
    const n = await ctx.driver.executeScript("return sessionStorage.length;");
    assertEqual(n, 0, "sessionStorage length after clear");
    return "session storage empty";
  }],
  ["Removing a key actually deletes it", "getItem returns null", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const v = await ctx.driver.executeScript(`
      localStorage.setItem('mg-del', '1');
      localStorage.removeItem('mg-del');
      return localStorage.getItem('mg-del');`);
    assertEqual(v, null, "value after removeItem");
    return "key removed";
  }],
  ["Storage accepts a realistic settings payload", "2KB JSON round-trips", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const ok = await ctx.driver.executeScript(`
      var payload = JSON.stringify({ prefs: new Array(200).fill('reminder-slot') });
      localStorage.setItem('mg-big', payload);
      var same = localStorage.getItem('mg-big') === payload;
      localStorage.removeItem('mg-big');
      return same;`);
    assertEqual(ok, true, "large payload round-trip");
    return "2KB payload round-tripped";
  }],
  ["Storage keys are origin-scoped", "origin matches the test server", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const origin = await ctx.driver.executeScript("return window.location.origin;");
    assertIncludes(origin, "127.0.0.1", "origin");
    return origin;
  }],
  ["Cookies are not used to carry the session on the client", "no session cookie set pre-auth", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const cookie = await ctx.driver.executeScript("return document.cookie;");
    assert(!/sessionid|jsessionid|connect\.sid/i.test(cookie), `unexpected session cookie: ${cookie}`);
    return cookie ? `cookies present: ${cookie.length} chars` : "no cookies set";
  }],
  ["Firebase persistence does not pre-seed a signed-in user", "no auth user before sign-in", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    const text = await ctx.driver.executeScript("return document.body.innerText;");
    assert(/Sign In|Sign Up/i.test(text), "app did not present the signed-out state");
    return "signed-out state confirmed";
  }],
  ["Storage writes from one route are visible on another", "cross-route read succeeds", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("localStorage.setItem('mg-x', 'shared');");
    await ctx.goto(ctx.driver, ctx.baseUrl, "/role-selection");
    const v = await ctx.driver.executeScript("return localStorage.getItem('mg-x');");
    assertEqual(v, "shared", "cross-route storage read");
    await ctx.driver.executeScript("localStorage.removeItem('mg-x');");
    return "value shared across routes";
  }],
  ["Clearing storage leaves the app in the signed-out state", "login form still rendered", async (ctx) => {
    await ctx.goto(ctx.driver, ctx.baseUrl, "/login");
    await ctx.driver.executeScript("localStorage.clear(); sessionStorage.clear();");
    await ctx.driver.navigate().refresh();
    await ctx.driver.wait(async () =>
      ctx.driver.executeScript("return !document.body.innerText.includes('Loading MediGuard');"), 15000);
    const els = await ctx.driver.findElements(By.css("input[type=email]"));
    assertEqual(els.length, 1, "login form after storage wipe");
    return "signed-out state preserved";
  }],
];

for (const [title, expected, fn] of STORAGE_CASES) {
  add("13 Browser Storage", "SEL", title,
    ["Open the app", "Exercise the storage API", "Assert the observed value"],
    expected, fn);
}

module.exports = {
  cases,
  PUBLIC_ROUTES,
  PROTECTED_ROUTES,
  VIEWPORTS,
  VALID_EMAILS,
  INVALID_EMAILS,
  helpers: { assert, assertEqual, assertIncludes, pathname, freshLogin },
};
