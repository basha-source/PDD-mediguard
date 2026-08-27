# MediGuard — Test & Security Suites

Four independent suites, **900 functional test cases** plus a full security assessment.
Every suite writes an Excel workbook and every workbook is published as a GitHub
Actions artifact.

| Suite | Cases | What it drives | Report |
| --- | ---: | --- | --- |
| [`selenium-tests/`](selenium-tests) | 300 | Real headless Chrome against a production build of `apps/web` | `selenium-test-report.xlsx` |
| [`appium-tests/`](appium-tests) | 300 | Appium 2 / UiAutomator2 specs for `apps/mobile` | `appium-test-report.xlsx` |
| [`load-tests/`](load-tests) | 300 | 100 virtual users × 60s × 4 scenarios against the API | `load-test-report.xlsx` |
| [`security-tests/`](security-tests) | 21 findings | SAST with per-finding re-verification, secret scan, dependency audit | `findings.xlsx`, `endpoint-inventory.xlsx` |

---

## Quick start

```bash
# 1. Selenium — needs a web build first
pnpm --filter @mediguard/web build
cd selenium-tests && npm install && node run.js

# 2. Appium — no device needed for the default contract mode
cd appium-tests && npm install && node run.js

# 3. Load — needs the API running
pnpm --filter @mediguard/backend build
FIREBASE_SERVICE_ACCOUNT_KEY=placeholder GOOGLE_MAPS_API_KEY=placeholder \
  MISSED_DOSE_SCAN_ENABLED=false node apps/backend/dist/index.js &
cd load-tests && npm install && node baseline-load-test.js

# 4. Security
cd security-tests && npm install && node scan.js
```

Reports land in each suite's `reports/` directory, except the security suite which
writes to `Vulnerability Test Results/`.

---

## 1. Selenium — 300 web E2E cases

Drives a **real headless Chrome** against a real Vite production build of `apps/web`,
served over loopback with SPA fallback. Nothing is stubbed.

| # | Suite | Cases | Coverage |
| --- | --- | ---: | --- |
| 01 | Public Page Smoke | 28 | 4 public routes × 7 structural checks |
| 02 | Route Guard | 90 | All 30 protected routes × 3 checks — anonymous visitors must land on `/login` |
| 03 | Login Form Interaction | 28 | Typing, masking, tab switching, constraint validation |
| 04/05 | Email Validation | 24 | 12 valid + 12 malformed addresses via the browser's own `checkValidity()` |
| 06 | Password Field Handling | 16 | 8 fixtures × round-trip + masking |
| 07 | Responsive Layout | 24 | 6 viewports (320px→1920px) × 4 pages, asserting no overflow |
| 08 | Navigation & History | 18 | Deep links, back/forward, reload, query/hash handling |
| 09 | Accessibility | 20 | Labels, landmarks, focus order, tap-target sizes |
| 10 | Client Security Hardening | 16 | XSS payloads, traversal, credential leakage, security headers |
| 11 | Performance Budget | 12 | Navigation Timing, DOM size, transfer bytes |
| 12 | Error Handling | 12 | Blocked network, corrupt storage, rapid navigation, failed sign-in |
| 13 | Browser Storage | 12 | localStorage/sessionStorage behaviour and isolation |

```bash
node run.js                    # all 300, headless
HEADLESS=false node run.js     # watch it run
node run.js --filter=Guard     # one suite
node run.js --bail             # stop at first failure
node tests/login-tests.js      # focused auth suite, own report
```

`tests/login-tests.js` is the standalone authentication suite with a page object and
readable specs. It covers rendering, mode switching, credential handling, validation,
the access-control boundary for **every** protected route, and failure behaviour.

---

## 2. Appium — 300 mobile E2E cases

> **Read this before trusting a green run.**

The suite runs in one of two modes, and **the mode is stamped on every row of the
report**:

| Mode | What happens | When |
| --- | --- | --- |
| `MODE=device` | Connects to an Appium server, installs the APK, executes real taps | Local, with an emulator |
| `MODE=contract` | No device. Each spec is verified against a model parsed from the real `apps/mobile` source | **CI default** |

Contract mode verifies that every spec's route is registered in a navigator, its
component resolves to a real screen file, the text its selector targets still exists
in that screen, and every `navigate()` target in the app is a real route. It catches
deleted screens, renamed routes, dead navigation links and reworded selectors.

**It does not prove the app renders or responds to taps.** To do that:

```bash
npm i -D webdriverio appium
npx appium driver install uiautomator2
npx appium                                    # separate terminal
MODE=device APP_PATH=/abs/path/app.apk node run.js
```

### Why the suite is built this way

`apps/mobile` ships **zero `testID` and zero `accessibilityLabel` attributes** across
all 72 source files. There is no stable automation handle anywhere in the tree, so
selectors must fall back to rendered text — which changes silently. Pinning that text
against source is the only way to make a text selector safe. This is tracked as
finding **MG-SEC-016 / MOB-AUTO-001**, and it is also why the app is unusable with
TalkBack.

| # | Suite | Cases |
| --- | --- | ---: |
| 01 | Navigator Registry | 88 (44 routes × 2) |
| 02 | Screen Render Contract | 44 |
| 03 | Navigation Graph | 34 |
| 04 | Interaction Surface | 44 |
| 05 | Authentication Journey | 26 |
| 06 | Patient Tab Journey | 18 |
| 07 | Care Guardian Journey | 14 |
| 08 | Native Capabilities | 20 |
| 09 | Automation Readiness | 12 |

---

## 3. Load — baseline performance

Profile: **100 concurrent virtual users, 60 seconds, 4 scenarios**, via `autocannon`.

Produces 300 assertions: 15 aggregate metrics × 4 scenarios, plus one throughput
assertion per 1-second window × 4 scenarios.

### Measured on a local instance

| Scenario | Requests | RPS (mean) | Latency mean | p99 | Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /health` | 796,250 | 13,271 | 7.0 ms | 9 ms | 0 |
| `GET /` | 802,909 | 13,382 | 7.0 ms | 9 ms | 0 |
| `GET /api/does-not-exist` | 973,484 | 16,226 | 5.7 ms | 7 ms | 0 |
| `POST /health` (bad method) | 733,900 | 12,233 | 7.7 ms | 10 ms | 0 |

Comfortably inside the SLO (≥50 RPS, ≤250 ms mean, ≤1500 ms p99, ≤1% errors).

### Which endpoints are excluded, and why

Only endpoints that are safe to hammer are in the profile. Deliberately **not** load
tested:

- `/api/ai/ask`, `/api/medicines/ocr` — proxy to the ML service on a free Hugging Face
  tier. 100 VUs would DoS a third party, not test MediGuard.
- `/api/medicines/lookup`, `/api/interactions/*` — call openFDA and UPCitemdb, which
  are rate-limited public APIs belonging to someone else.
- `/api/auth/*` — rate limited to 10 req/15 min by design, so the profile would measure
  `express-rate-limit`, not the application.

```bash
node baseline-load-test.js                              # 100 VU × 60s
CONNECTIONS=50 DURATION=30 node baseline-load-test.js   # lighter
DURATION=10 npm run test:quick                          # smoke
```

---

## 4. Security assessment

```bash
cd security-tests && node scan.js
```

Runs all eight phases and writes to `Vulnerability Test Results/`:

```
security-review.md        full findings with exploitation scenarios and fixes
executive-summary.md      severity counts, top risks, score, remediation order
dependency-report.md      CVE list split by runtime vs build-only reachability
findings.xlsx             4 sheets: Findings, Endpoints, Dependencies, Risk Summary
endpoint-inventory.xlsx   API inventory + backend inventory
scan-results.json         machine-readable output
```

**Every finding re-verifies itself against the current source at scan time.** Fixed
findings report as `REMEDIATED` and stop counting toward the score, so the report can
never drift from the code.

### Current posture

| | |
| --- | --- |
| Score | **58/100** (D — serious, not production ready) |
| Critical | 0 |
| High | 6 |
| Medium | 8 |
| Low | 5 |

Two critical findings were **found and fixed** during this assessment:

- **MG-SEC-001** — `CRON_SECRET` fell back to the hardcoded literal `"dev-cron-secret"`,
  which is in this repository's git history. `render.yaml` declares the variable with
  `sync: false`, so a deployment that skipped that prompt shipped guarded by a secret
  anyone could read. The fallback is removed; the route now fails closed when unset and
  compares with `timingSafeEqual`.
- **MG-SEC-002** — `POST /api/auth/revoke-tokens` read `uid` from the request body with
  no authentication, letting any anonymous caller sign out any account whose Firebase
  UID they knew. Identity now comes from the verified ID token only.

Both endpoints had zero callers in the web app, mobile app, or any script, so the fixes
changed no working behaviour.

---

## GitHub Actions

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `test-suite.yml` | push, PR, manual | Runs all four suites in parallel, uploads every Excel report, writes a results table to the run summary |
| `security-review.yml` | push, PR, manual | 8-phase DevSecOps pipeline: stack detection → SAST (custom + Semgrep) → secret scan (Gitleaks) → dependency scan (Trivy + pnpm/pip audit) → local dynamic probes → reports. **Fails only on CRITICAL.** |

### Downloading the reports

Open any run → **Artifacts** at the bottom:

| Artifact | Contents |
| --- | --- |
| `ALL-TEST-REPORTS` | Everything below, in one bundle |
| `selenium-test-reports` | 300-case + login-focused workbooks |
| `appium-test-reports` | 300-case + journey workbooks |
| `load-test-reports` | Load workbook (4 sheets incl. throughput timeline) |
| `security-assessment-reports` | Findings, endpoint inventory, all three markdown reports |

### Workbook layout

Every workbook has a **Test Summary** sheet (run metadata, totals, per-suite
breakdown) and a **Test Details** sheet (one row per case: ID, suite, title, steps,
expected, actual, status, duration, error). The Appium workbook adds a **Mode** column
so a reader can always tell whether a green row involved a real device. The load
workbook adds **Performance Metrics** and **Throughput Timeline** sheets.
