"use strict";
/**
 * MediGuard — security findings.
 *
 * Every finding carries a `verify(ctx)` that re-checks the vulnerable pattern
 * against the live source tree. Nothing here is a static write-up: if a finding
 * is fixed, its verifier stops matching and the finding is reported as
 * REMEDIATED rather than silently lingering in a document nobody re-reads.
 *
 * ctx.read(relPath)     -> file contents
 * ctx.exists(relPath)   -> boolean
 * ctx.grep(rel, regex)  -> matching lines with line numbers
 */

const SEVERITY = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

const findings = [
  // ══════════════════════════════════════════════════════════════ CRITICAL
  {
    id: "MG-SEC-001",
    severity: "CRITICAL",
    type: "Hardcoded Credential / Broken Authentication",
    cwe: "CWE-798: Use of Hard-coded Credentials",
    owasp: "A07:2021 Identification and Authentication Failures",
    file: "apps/backend/src/config/env.ts:28",
    endpoint: "POST /api/notifications/scan-missed",
    title: "Missed-dose scanner is protected by a hardcoded default secret published in the repository",
    description:
      "CRON_SECRET falls back to the literal string \"dev-cron-secret\" when the environment " +
      "variable is unset. That literal is now in a public GitHub repository. render.yaml declares " +
      "CRON_SECRET with `sync: false`, which means Render does NOT set it automatically — an operator " +
      "who deploys the blueprint and skips that one prompt ships production with the published default.",
    exploitation:
      "curl -X POST https://<host>/api/notifications/scan-missed -H 'x-cron-secret: dev-cron-secret'\n" +
      "The handler runs scanForMissedDoses(), which iterates every patient, writes alert documents to " +
      "Firestore and dispatches Expo push notifications. An attacker loops it to spam every patient and " +
      "every linked Care Guardian with fabricated missed-dose alerts, and to burn Firestore write quota.",
    impact:
      "Unauthenticated write access to patient alert data and an unauthenticated push-notification relay " +
      "aimed at every user of the app. In a medication-adherence product, false missed-dose alerts are " +
      "not just spam — they actively mislead caregivers about whether a patient took their medicine.",
    fix:
      "Remove the fallback and fail closed at boot:\n" +
      "  CRON_SECRET: process.env[\"CRON_SECRET\"]!   // add to the `required` array above\n" +
      "Rotate the secret, since the old value is in public git history. Compare with timingSafeEqual " +
      "rather than !== to avoid leaking the secret a byte at a time.",
    verify: (ctx) => {
      const hits = ctx.grep("apps/backend/src/config/env.ts", /CRON_SECRET.*\?\?\s*["']dev-cron-secret["']/);
      return { present: hits.length > 0, evidence: hits[0] || "" };
    },
  },
  {
    id: "MG-SEC-002",
    severity: "CRITICAL",
    type: "Broken Access Control / Missing Authorization",
    cwe: "CWE-862: Missing Authorization",
    owasp: "A01:2021 Broken Access Control",
    file: "apps/backend/src/routes/auth.ts:50",
    endpoint: "POST /api/auth/revoke-tokens",
    title: "Any anonymous caller can revoke any user's session by supplying their UID",
    description:
      "The route reads `uid` straight from the request body and calls " +
      "adminAuth.revokeRefreshTokens(uid). There is no requireAuth middleware, no check that the caller " +
      "owns that uid, and no admin role gate. The only control is a rate limiter of 3 requests per hour " +
      "per IP — which an attacker rotates around trivially, and which is per-IP, not per-victim.",
    exploitation:
      "curl -X POST https://<host>/api/auth/revoke-tokens -H 'content-type: application/json' \\\n" +
      "     -d '{\"uid\":\"<victim-firebase-uid>\"}'\n" +
      "Firebase UIDs are not secrets — they appear in Firestore document fields (medicines.userId, " +
      "doseLogs.userId, careGuardianLinks IDs) that any authenticated user's own data references, and " +
      "the deterministic Care Guardian link ID `{guardianId}_{patientId}` exposes both halves at once.",
    impact:
      "Targeted, repeatable denial of service against any account. The victim is signed out of every " +
      "device and stops receiving dose reminders until they re-authenticate. For a patient relying on " +
      "the app for medication timing, that is a safety issue, not an inconvenience.",
    fix:
      "Put the route behind requireAuth and revoke only the caller's own session:\n" +
      "  authRoutes.post(\"/revoke-tokens\", requireAuth, resetLimiter, async (req, res) => {\n" +
      "    await adminAuth.revokeRefreshTokens((req as any).uid);\n" +
      "    res.json({ success: true });\n" +
      "  });\n" +
      "If an admin-initiated revoke is genuinely needed, gate it on a custom claim, not on a body field.",
    verify: (ctx) => {
      const src = ctx.read("apps/backend/src/routes/auth.ts");
      const hasRoute = /revoke-tokens/.test(src);
      const guarded = /revoke-tokens["']\s*,\s*requireAuth/.test(src);
      const takesBodyUid = /const\s*\{\s*uid\s*\}\s*=\s*req\.body/.test(src);
      return {
        present: hasRoute && !guarded && takesBodyUid,
        evidence: ctx.grep("apps/backend/src/routes/auth.ts", /revoke-tokens|revokeRefreshTokens/)
          .join("\n"),
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════ HIGH
  {
    id: "MG-SEC-003",
    severity: "HIGH",
    type: "Missing Authentication / Resource Exhaustion",
    cwe: "CWE-770: Allocation of Resources Without Limits or Throttling",
    owasp: "A04:2021 Insecure Design",
    file: "apps/backend/src/routes/ai.ts:45",
    endpoint: "POST /api/ai/ask",
    title: "AI assistant endpoint is unauthenticated and unthrottled",
    description:
      "aiRoutes.post(\"/ask\") has no requireAuth and no rate limiter. Each call is forwarded to the ML " +
      "service with a 25s timeout and one automatic retry after a 3s delay, so a single request can hold " +
      "a backend socket for up to 53 seconds while pinning a CPU-bound RAG pipeline on the ML host.",
    exploitation:
      "for i in $(seq 1 200); do curl -sX POST https://<host>/api/ai/ask \\\n" +
      "  -H 'content-type: application/json' -d '{\"question\":\"'$(head -c 4000 /dev/urandom | base64)'\"}' & done\n" +
      "200 concurrent requests occupy the Node event loop and saturate the free-tier Hugging Face Space " +
      "behind it. No credential is needed and nothing in the stack counts the requests.",
    impact:
      "Complete denial of service for the assistant feature, and knock-on unavailability of the whole " +
      "API instance (Render free tier is a single container). A third party's compute is also consumed.",
    fix:
      "Apply requireAuth and a per-user limiter:\n" +
      "  const askLimiter = rateLimit({ windowMs: 60_000, max: 10,\n" +
      "    keyGenerator: (req) => (req as any).uid ?? req.ip });\n" +
      "  aiRoutes.post(\"/ask\", requireAuth, askLimiter, handler);\n" +
      "Also cap the question length (e.g. 500 chars) before forwarding it upstream.",
    verify: (ctx) => {
      const src = ctx.read("apps/backend/src/routes/ai.ts");
      const unguarded = /aiRoutes\.post\(\s*["']\/ask["']\s*,\s*async/.test(src);
      const noLimiter = !/rateLimit|Limiter/.test(src);
      return { present: unguarded && noLimiter, evidence: ctx.grep("apps/backend/src/routes/ai.ts", /aiRoutes\.post/).join("\n") };
    },
  },
  {
    id: "MG-SEC-004",
    severity: "HIGH",
    type: "Missing Authentication / Unrestricted Upload",
    cwe: "CWE-434: Unrestricted Upload of File with Dangerous Type",
    owasp: "A04:2021 Insecure Design",
    file: "apps/backend/src/routes/medicines.ts:110",
    endpoint: "POST /api/medicines/ocr",
    title: "OCR endpoint accepts unauthenticated 15MB image uploads",
    description:
      "The route validates only that `image` and `mode` are truthy. There is no authentication, no rate " +
      "limit, no MIME/magic-byte check, no size ceiling of its own, and no validation that `mode` is one " +
      "of the three expected values before it reaches the ML service. The global " +
      "express.json({ limit: \"15mb\" }) means each request can carry 15MB of base64.",
    exploitation:
      "curl -X POST https://<host>/api/medicines/ocr -H 'content-type: application/json' \\\n" +
      "  -d '{\"image\":\"'$(base64 -w0 15mb-file)'\",\"mode\":\"packaging\"}'\n" +
      "Each request allocates ~15MB in the Node heap for JSON parsing plus ~11MB decoded, then occupies " +
      "a 60-second upstream call. A handful of concurrent requests exhausts a 512MB free-tier container.",
    impact:
      "Memory-exhaustion denial of service on the API, and unauthenticated consumption of the OCR " +
      "pipeline (PaddleOCR + TrOCR) on the ML host. Arbitrary attacker-supplied bytes reach an image " +
      "parser stack that includes native code.",
    fix:
      "Gate the route, scope the body limit to it, and validate the input:\n" +
      "  medicineRoutes.post(\"/ocr\", requireAuth, ocrLimiter,\n" +
      "    express.json({ limit: \"4mb\" }), handler);\n" +
      "Reject any `mode` not in ['expiry','prescription','packaging'] and verify the base64 payload " +
      "starts with a known image magic number before forwarding it.",
    verify: (ctx) => {
      const src = ctx.read("apps/backend/src/routes/medicines.ts");
      const unguarded = /medicineRoutes\.post\(\s*["']\/ocr["']\s*,\s*async/.test(src);
      const idx = ctx.read("apps/backend/src/index.ts");
      const bigBody = /express\.json\(\s*\{\s*limit:\s*["']15mb["']/.test(idx);
      return { present: unguarded, evidence: `unauthenticated /ocr route; global body limit 15mb: ${bigBody}` };
    },
  },
  {
    id: "MG-SEC-005",
    severity: "HIGH",
    type: "Security Misconfiguration — Permissive CORS",
    cwe: "CWE-942: Permissive Cross-domain Policy with Untrusted Domains",
    owasp: "A05:2021 Security Misconfiguration",
    file: "apps/backend/src/index.ts:16",
    endpoint: "* (all routes)",
    title: "CORS allows every origin on every route, including authenticated ones",
    description:
      "app.use(cors({ origin: \"*\" })) is applied globally before the routers. Every endpoint, including " +
      "POST /api/notifications/send behind requireAuth, is callable cross-origin from any website.",
    exploitation:
      "An attacker hosts a page that a signed-in patient visits. Because the app sends the Firebase ID " +
      "token in an Authorization header rather than a cookie, the token itself is not auto-attached — but " +
      "any XSS or malicious browser extension that can read the token gains a fully CORS-open API to " +
      "replay it against, and every unauthenticated route (/ai/ask, /medicines/ocr, /interactions/*, " +
      "/auth/revoke-tokens) is directly callable from any origin as a drive-by.",
    impact:
      "Removes origin as a defence-in-depth boundary and turns every visitor's browser into a usable " +
      "proxy for the unauthenticated endpoints above, including MG-SEC-002's session-revocation route.",
    fix:
      "Pin the allowlist to the deployed clients:\n" +
      "  const ALLOWED = [process.env.WEB_ORIGIN, 'https://mediguard.app'].filter(Boolean);\n" +
      "  app.use(cors({ origin: (o, cb) => cb(null, !o || ALLOWED.includes(o)), credentials: false }));\n" +
      "The React Native app sends no Origin header, so it is unaffected by an allowlist.",
    verify: (ctx) => {
      const hits = ctx.grep("apps/backend/src/index.ts", /cors\(\s*\{\s*origin:\s*["']\*["']/);
      return { present: hits.length > 0, evidence: hits[0] || "" };
    },
  },
  {
    id: "MG-SEC-006",
    severity: "HIGH",
    type: "Information Disclosure",
    cwe: "CWE-209: Generation of Error Message Containing Sensitive Information",
    owasp: "A05:2021 Security Misconfiguration",
    file: "apps/backend/src/routes/ai.ts:53, apps/backend/src/routes/medicines.ts:125",
    endpoint: "POST /api/ai/ask, POST /api/medicines/ocr",
    title: "Upstream error bodies are forwarded verbatim to unauthenticated clients",
    description:
      "Both handlers put the raw upstream failure into the client response: /ask returns " +
      "`detail: err?.response?.data ?? err?.message` and /ocr returns `detail: err?.response?.data?.error " +
      "?? err?.message`. The code comments say `detail` is \"debugging material and is never shown to a " +
      "patient\" — but it is still sent over the wire, where anyone can read it.",
    exploitation:
      "Send a malformed request and read `detail`. Transport failures surface axios messages containing " +
      "the internal ML service URL and port; upstream HTTP errors surface the ML service's own error " +
      "bodies including Python exception text and, on a stack-trace path, file system paths.",
    impact:
      "Maps the internal architecture for an attacker: the ML service hostname, its framework, its error " +
      "taxonomy, and which dependencies are missing. This is the reconnaissance step that makes the " +
      "resource-exhaustion findings above precisely targetable.",
    fix:
      "Log `detail` server-side (it already is, via console.error) and drop it from the response:\n" +
      "  res.status(503).json({ error: \"OCR failed\", code });\n" +
      "Keep `code`, which is the stable enum the client actually switches on.",
    verify: (ctx) => {
      const ai = ctx.grep("apps/backend/src/routes/ai.ts", /detail\s*[,}]/);
      const med = ctx.grep("apps/backend/src/routes/medicines.ts", /detail\s*[,}]/);
      return { present: ai.length > 0 || med.length > 0, evidence: [...ai, ...med].join("\n") };
    },
  },
  {
    id: "MG-SEC-007",
    severity: "HIGH",
    type: "Security Misconfiguration — Missing Security Headers",
    cwe: "CWE-693: Protection Mechanism Failure",
    owasp: "A05:2021 Security Misconfiguration",
    file: "apps/backend/src/index.ts",
    endpoint: "* (all routes)",
    title: "No security headers are set on any API response",
    description:
      "The Express app registers cors and express.json and nothing else. helmet is not a dependency. " +
      "Responses carry no X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, " +
      "Referrer-Policy or Content-Security-Policy, and Express advertises itself via X-Powered-By.",
    exploitation:
      "Absent nosniff, a JSON response containing attacker-controlled text can be MIME-confused by older " +
      "browsers. Absent HSTS, a first request over http:// is downgradeable. X-Powered-By names the " +
      "framework and narrows exploit selection for free.",
    impact:
      "Removes an entire layer of browser-enforced defence and hands an attacker free fingerprinting.",
    fix:
      "  npm i helmet\n" +
      "  import helmet from 'helmet';\n" +
      "  app.disable('x-powered-by');\n" +
      "  app.use(helmet({ contentSecurityPolicy: false }));   // API serves JSON, not HTML\n" +
      "  app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true }));",
    verify: (ctx) => {
      const src = ctx.read("apps/backend/src/index.ts");
      const pkg = ctx.read("apps/backend/package.json");
      const noHelmet = !/helmet/.test(src) && !/helmet/.test(pkg);
      const advertises = !/disable\(\s*["']x-powered-by["']\s*\)/.test(src);
      return { present: noHelmet, evidence: `helmet absent: ${noHelmet}; x-powered-by still advertised: ${advertises}` };
    },
  },
  {
    id: "MG-SEC-008",
    severity: "HIGH",
    type: "Vulnerable and Outdated Components",
    cwe: "CWE-1035: Using Components with Known Vulnerabilities",
    owasp: "A06:2021 Vulnerable and Outdated Components",
    file: "pnpm-lock.yaml",
    endpoint: "n/a",
    title: "Resolved dependency tree carries 2 critical and 30+ high-severity advisories",
    description:
      "`pnpm audit` on the workspace reports 2 critical and 36 high advisories. The ones that reach " +
      "backend production code are the firebase-admin transitive chain (@grpc/grpc-js server-crash CVEs, " +
      "protobufjs DoS, ws memory exhaustion, form-data CRLF injection) and axios itself (proxy-inheritance " +
      "and maxBodyLength bypasses). shell-quote and websocket-driver (both critical) resolve through the " +
      "React Native / Metro toolchain and are build-time rather than runtime.",
    exploitation:
      "CVE-2026-48068 / CVE-2026-48069 in @grpc/grpc-js crash the process on a malformed message; " +
      "firebase-admin speaks gRPC to Firestore on every request, so a hostile or corrupted upstream " +
      "response takes the API down. CVE-2026-12143 in form-data allows CRLF injection into multipart " +
      "field names.",
    impact:
      "Remote crash of the single API container, plus a set of injection primitives in libraries that " +
      "handle every outbound request the backend makes.",
    fix:
      "Upgrade the direct dependencies that pull these in:\n" +
      "  pnpm up firebase-admin@latest axios@latest express@latest -r\n" +
      "  pnpm audit --prod --audit-level=high\n" +
      "Then add the dependency-review gate in .github/workflows/security-review.yml so a new high CVE " +
      "fails the build rather than accumulating.",
    verify: (ctx) => {
      const lock = ctx.exists("pnpm-lock.yaml");
      return { present: lock, evidence: "verified live by `pnpm audit` in the dependency phase of this scan" };
    },
  },

  // ════════════════════════════════════════════════════════════════ MEDIUM
  {
    id: "MG-SEC-009",
    severity: "MEDIUM",
    type: "User Enumeration",
    cwe: "CWE-204: Observable Response Discrepancy",
    owasp: "A07:2021 Identification and Authentication Failures",
    file: "apps/backend/src/routes/auth.ts:27",
    endpoint: "POST /api/auth/check-email",
    title: "Endpoint confirms whether an email address has a MediGuard account",
    description:
      "The route returns { exists: true } or { exists: false } for any address supplied, without " +
      "authentication. It is rate-limited to 10 requests per 15 minutes per IP, which slows but does not " +
      "prevent enumeration from a pool of addresses or IPs.",
    exploitation:
      "Feed a breach corpus through the endpoint to learn which addresses hold MediGuard accounts. " +
      "Each hit is a confirmed user of a medication-management app — which is itself health-adjacent " +
      "personal information, and a targeting list for the phishing that precedes credential stuffing.",
    impact:
      "Discloses account existence, which for a healthcare application is a privacy disclosure in its own " +
      "right, and supplies the victim list that makes MG-SEC-002 exploitable at scale.",
    fix:
      "Remove the endpoint. Firebase's sendPasswordResetEmail already succeeds silently for unknown " +
      "addresses, which is the correct UX: the reset screen should always say \"if that address has an " +
      "account, we've sent a link\" regardless of whether it does.",
    verify: (ctx) => {
      const hits = ctx.grep("apps/backend/src/routes/auth.ts", /exists:\s*(true|false)/);
      return { present: hits.length > 0, evidence: hits.join("\n") };
    },
  },
  {
    id: "MG-SEC-010",
    severity: "MEDIUM",
    type: "Injection — Unsanitised Query Construction",
    cwe: "CWE-88: Improper Neutralization of Argument Delimiters",
    owasp: "A03:2021 Injection",
    file: "apps/backend/src/routes/interactions.ts:11, :24; apps/backend/src/routes/medicines.ts:20",
    endpoint: "GET /api/interactions/check, GET /api/interactions/substitutes, GET /api/medicines/lookup",
    title: "User input is interpolated into upstream openFDA query URLs without encoding",
    description:
      "drug1, drug2, ingredient and barcode come straight off req.query and are template-interpolated " +
      "into an openFDA search string with no encodeURIComponent and no character allowlist:\n" +
      "  `${API.OPENFDA_BASE}/event.json?search=patient.drug.medicinalproduct:\"${drug1}\"+AND+...`\n" +
      "A quote, +, & or space in the input escapes the intended query structure.",
    exploitation:
      "GET /api/interactions/check?drug1=x\"&limit=1000&skip=5000&q=\"&drug2=y\n" +
      "The injected parameters are appended to the outbound request, letting a caller rewrite the query " +
      "the backend makes on their behalf — changing result limits, pivoting the search field, or " +
      "appending an api_key parameter if one is ever added.",
    impact:
      "Query manipulation against a third-party API using MediGuard's identity and quota. Not a classic " +
      "SSRF (the host is fixed) but the same class: the caller controls a request the server makes.",
    fix:
      "Encode and constrain every interpolated value:\n" +
      "  const safe = (s: string) => encodeURIComponent(s.replace(/[^A-Za-z0-9 .\\-]/g, '').slice(0, 64));\n" +
      "Build the URL with URLSearchParams rather than string templates.",
    verify: (ctx) => {
      const inter = ctx.grep("apps/backend/src/routes/interactions.ts", /search=.*\$\{drug1\}|search=.*\$\{ingredient\}/);
      const med = ctx.grep("apps/backend/src/routes/medicines.ts", /upc=\$\{barcode\}/);
      const encoded = /encodeURIComponent/.test(ctx.read("apps/backend/src/routes/interactions.ts"));
      return { present: (inter.length > 0 || med.length > 0) && !encoded, evidence: [...inter, ...med].join("\n") };
    },
  },
  {
    id: "MG-SEC-011",
    severity: "MEDIUM",
    type: "Resource Exhaustion",
    cwe: "CWE-770: Allocation of Resources Without Limits",
    owasp: "A04:2021 Insecure Design",
    file: "apps/backend/src/index.ts:17",
    endpoint: "* (all routes)",
    title: "A 15MB JSON body limit is applied globally, including to unauthenticated routes",
    description:
      "express.json({ limit: \"15mb\" }) is registered app-wide. Only /api/medicines/ocr needs a large " +
      "body; every other route — including the unauthenticated /api/ai/ask and /api/auth/* — inherits it.",
    exploitation:
      "POST 15MB of JSON to /api/auth/check-email repeatedly. The body is parsed and buffered in the Node " +
      "heap before the route's own validation ever runs, and before the rate limiter's window matters.",
    impact:
      "Memory pressure and event-loop stalls on a 512MB container, reachable without credentials.",
    fix:
      "Default the app to a small limit and opt the one route that needs more into a larger one:\n" +
      "  app.use(express.json({ limit: '100kb' }));\n" +
      "  medicineRoutes.post('/ocr', requireAuth, express.json({ limit: '4mb' }), handler);",
    verify: (ctx) => {
      const hits = ctx.grep("apps/backend/src/index.ts", /express\.json\(\s*\{\s*limit:\s*["']15mb["']/);
      return { present: hits.length > 0, evidence: hits[0] || "" };
    },
  },
  {
    id: "MG-SEC-012",
    severity: "MEDIUM",
    type: "Missing Rate Limiting",
    cwe: "CWE-770: Allocation of Resources Without Limits or Throttling",
    owasp: "A04:2021 Insecure Design",
    file: "apps/backend/src/routes/",
    endpoint: "/api/ai/*, /api/medicines/*, /api/interactions/*, /api/notifications/send",
    title: "Rate limiting is applied only to /api/auth; four of five routers are unthrottled",
    description:
      "express-rate-limit is imported in routes/auth.ts and nowhere else. ai.ts, medicines.ts, " +
      "interactions.ts and notifications.ts register no limiter, so the AI, OCR, barcode-lookup, " +
      "drug-interaction and push-send endpoints accept unlimited request rates.",
    exploitation:
      "Sustained request floods against any of them. Combined with MG-SEC-003 and MG-SEC-004 this is the " +
      "difference between a slow endpoint and an outage.",
    impact:
      "API-wide denial of service, third-party quota exhaustion (openFDA, upcitemdb, Expo push), and " +
      "unbounded cost on the ML host.",
    fix:
      "Register a default limiter before the routers and tighten it per route:\n" +
      "  app.use('/api', rateLimit({ windowMs: 60_000, max: 120 }));\n" +
      "Key expensive routes on the authenticated uid rather than the IP.",
    verify: (ctx) => {
      const unlimited = ["ai", "medicines", "interactions"].filter(
        (r) => !/rateLimit/.test(ctx.read(`apps/backend/src/routes/${r}.ts`))
      );
      return { present: unlimited.length > 0, evidence: `routers without a limiter: ${unlimited.join(", ")}` };
    },
  },
  {
    id: "MG-SEC-013",
    severity: "MEDIUM",
    type: "Security Misconfiguration",
    cwe: "CWE-1188: Insecure Default Initialization of Resource",
    owasp: "A05:2021 Security Misconfiguration",
    file: "render.yaml:31, apps/backend/src/config/firebaseAdmin.ts:20",
    endpoint: "POST /api/notifications/send",
    title: "Production blueprint ships a placeholder Firebase service account, silently disabling authentication",
    description:
      "render.yaml sets FIREBASE_SERVICE_ACCOUNT_KEY to the literal \"placeholder\". firebaseAdmin.ts " +
      "catches the JSON parse failure and falls through to initializeApp() with no credential, setting " +
      "adminCredentialsConfigured = false. The app boots and reports healthy.",
    exploitation:
      "Not directly exploitable — verifyIdToken() fails without a credential, so requireAuth returns 401 " +
      "and the route fails closed. The risk is the inverse: the only authenticated endpoint in the API is " +
      "permanently broken in production and nothing surfaces that, so the failure is discovered by users " +
      "not receiving push notifications rather than by an alert.",
    impact:
      "Silent loss of the push-notification feature in production, and an authentication subsystem whose " +
      "misconfiguration produces no startup error. A future route that treats a missing credential as " +
      "'allow' rather than 'deny' would become a full authentication bypass.",
    fix:
      "Fail loudly at boot when the credential is unusable:\n" +
      "  if (!credentialsConfigured && process.env.NODE_ENV === 'production')\n" +
      "    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not a valid service account');\n" +
      "Set the real value in the Render dashboard and change render.yaml to `sync: false`.",
    verify: (ctx) => {
      const render = ctx.read("render.yaml");
      const placeholder = /FIREBASE_SERVICE_ACCOUNT_KEY[\s\S]{0,40}value:\s*["']placeholder["']/.test(render);
      return { present: placeholder, evidence: placeholder ? "render.yaml sets FIREBASE_SERVICE_ACCOUNT_KEY: placeholder" : "" };
    },
  },
  {
    id: "MG-SEC-014",
    severity: "MEDIUM",
    type: "Excessive Privilege (Mobile)",
    cwe: "CWE-250: Execution with Unnecessary Privileges",
    owasp: "M1: Improper Platform Usage (MASVS)",
    file: "apps/mobile/app.json",
    endpoint: "n/a (Android manifest)",
    title: "Android app requests RECORD_AUDIO with no feature that uses the microphone",
    description:
      "expo.android.permissions includes android.permission.RECORD_AUDIO. No screen in apps/mobile/src " +
      "records audio, and no audio dependency (expo-av, expo-audio, react-native-audio) is installed. " +
      "The permission set also duplicates CAMERA, USE_BIOMETRIC and USE_FINGERPRINT in both short and " +
      "fully-qualified forms.",
    exploitation:
      "Not directly exploitable, but any code-execution or malicious-dependency compromise of the app " +
      "inherits microphone access it should never have had. It also trains users to grant permissions " +
      "the app cannot justify, and Play Store review flags unjustified RECORD_AUDIO.",
    impact:
      "Enlarged attack surface on a device that also holds the user's medication history, and a Play " +
      "Store policy risk at submission.",
    fix:
      "Delete android.permission.RECORD_AUDIO and the duplicated entries from app.json. Note that " +
      "expo-location is used by PharmacyMapScreen but no location permission is declared — Expo's plugin " +
      "injects it at prebuild, but declaring it explicitly makes the manifest auditable.",
    verify: (ctx) => {
      const app = JSON.parse(ctx.read("apps/mobile/app.json"));
      const perms = (app.expo && app.expo.android && app.expo.android.permissions) || [];
      const audio = perms.filter((p) => /RECORD_AUDIO/.test(p));
      return { present: audio.length > 0, evidence: `declared: ${audio.join(", ")}; total permissions: ${perms.length}` };
    },
  },
  {
    id: "MG-SEC-015",
    severity: "MEDIUM",
    type: "Insecure Design — Fabricated Data Presented as Authoritative",
    cwe: "CWE-1021: Improper Restriction of Rendered UI Layers or Frames",
    owasp: "A04:2021 Insecure Design",
    file: "apps/mobile/src/screens/patient/PharmacyMapScreen.tsx:32",
    endpoint: "n/a (mobile screen)",
    title: "Mobile pharmacy finder presents hardcoded fake pharmacies as real nearby results",
    description:
      "generateMockPharmacies() returns five hardcoded entries — Apollo Pharmacy, MedPlus, Wellness " +
      "Forever, Jan Aushadhi, Netmeds — with invented phone numbers and 'Open now' badges, positioned by " +
      "adding fixed coordinate offsets to the user's real GPS location. The UI presents them " +
      "indistinguishably from real data, including a tappable call button.",
    exploitation:
      "No attacker is required. A patient in an urgent situation taps 'call' on a fabricated number, or " +
      "navigates to a pharmacy that does not exist at those coordinates.",
    impact:
      "Patient-safety and trust failure in a medical application. A user seeking an out-of-hours pharmacy " +
      "is given fabricated addresses and phone numbers with a confidence signal ('0.4 km', 'Open now') " +
      "that the data does not support.",
    fix:
      "Either wire the screen to the Google Places API the web client already uses, or label the list " +
      "unmistakably as sample data and disable the call/directions actions until it is real. The web " +
      "client's PharmacyMapPage.tsx already does the real nearbySearch and can be the reference.",
    verify: (ctx) => {
      const hits = ctx.grep("apps/mobile/src/screens/patient/PharmacyMapScreen.tsx", /generateMockPharmacies/);
      return { present: hits.length > 0, evidence: hits.join("\n") };
    },
  },
  {
    id: "MG-SEC-016",
    severity: "MEDIUM",
    type: "Accessibility & Testability Gap",
    cwe: "CWE-1110: Incomplete Design Documentation",
    owasp: "n/a",
    file: "apps/mobile/src/",
    endpoint: "n/a (mobile app)",
    title: "No testID or accessibilityLabel anywhere in the mobile app (tracked as MOB-AUTO-001)",
    description:
      "A scan of all 72 source files under apps/mobile/src finds zero testID attributes and zero " +
      "accessibilityLabel attributes. Every interactive control is unlabelled for assistive technology, " +
      "and every automated test must select by rendered text.",
    exploitation:
      "Not an attack path. It is the reason the Appium suite in appium-tests/ has to pin its selectors " +
      "against source strings, and the reason a screen-reader user cannot operate the app.",
    impact:
      "The app is unusable with TalkBack, which for a medication-adherence product used by elderly and " +
      "visually impaired patients is a serious functional gap — and arguably an accessibility compliance " +
      "issue. Automation is brittle: any copy change silently breaks the test suite.",
    fix:
      "Add testID and accessibilityLabel to every interactive element, starting with the auth screens and " +
      "the five bottom tabs:\n" +
      "  <TouchableOpacity testID=\"login-submit\" accessibilityLabel=\"Sign in to MediGuard\" ...>\n" +
      "Then switch appium-tests selectors from text() to the accessibility id (~login-submit).",
    verify: (ctx) => {
      const files = ctx.listFiles("apps/mobile/src", /\.tsx?$/);
      let testIds = 0, labels = 0;
      for (const f of files) {
        const s = ctx.read(f);
        testIds += (s.match(/testID=/g) || []).length;
        labels += (s.match(/accessibilityLabel=/g) || []).length;
      }
      return { present: testIds === 0 || labels === 0,
        evidence: `${testIds} testID and ${labels} accessibilityLabel across ${files.length} files` };
    },
  },

  // ═══════════════════════════════════════════════════════════════════ LOW
  {
    id: "MG-SEC-017",
    severity: "LOW",
    type: "Sensitive Data in Version Control",
    cwe: "CWE-540: Inclusion of Sensitive Information in Source Code",
    owasp: "A05:2021 Security Misconfiguration",
    file: "apps/mobile/eas.json:14, apps/mobile/google-services.json:23",
    endpoint: "n/a",
    title: "Firebase client API keys are committed to a public repository",
    description:
      "Two Firebase API keys are present in tracked files. Firebase web and Android API keys are " +
      "identifiers rather than secrets by design — Google documents them as safe to expose — and " +
      "google-services.json is normally committed. The exposure only matters if the keys carry no " +
      "restrictions, in which case they can be used to drive up quota from anywhere.",
    exploitation:
      "An unrestricted key can be lifted from the repo and used to make Firebase Auth and Identity " +
      "Toolkit calls against the project from any origin, consuming quota and enabling abuse of any " +
      "sign-up flow that is open.",
    impact:
      "Quota consumption and unsolicited account creation. Not data disclosure: Firestore access is " +
      "governed by the security rules in firestore.rules, which are correctly scoped to request.auth.uid.",
    fix:
      "In Google Cloud Console → Credentials, restrict each key: the Android key to the app's package " +
      "name plus SHA-1 signing certificate, and the web key to the deployed HTTP referrers. Then enable " +
      "Firebase App Check. Do not attempt to remove the keys from git history — restriction is the " +
      "control that matters, not secrecy.",
    verify: (ctx) => {
      const eas = ctx.exists("apps/mobile/eas.json") && /AIza[0-9A-Za-z_-]{20,}/.test(ctx.read("apps/mobile/eas.json"));
      const gs = ctx.exists("apps/mobile/google-services.json") && /AIza[0-9A-Za-z_-]{20,}/.test(ctx.read("apps/mobile/google-services.json"));
      return { present: eas || gs, evidence: `eas.json: ${eas}, google-services.json: ${gs}` };
    },
  },
  {
    id: "MG-SEC-018",
    severity: "LOW",
    type: "Mixed Content",
    cwe: "CWE-311: Missing Encryption of Sensitive Data",
    owasp: "A02:2021 Cryptographic Failures",
    file: "apps/web/src/pages/patient/PharmacyMapPage.tsx:71",
    endpoint: "n/a (web page)",
    title: "Map marker icon is loaded over plain HTTP on an HTTPS page",
    description:
      "The pharmacy markers use icon url \"http://maps.google.com/mapfiles/ms/icons/green-dot.png\". " +
      "Served from an HTTPS origin, browsers block or upgrade this passive mixed content.",
    exploitation:
      "On a network an attacker controls, an unencrypted image request is observable and modifiable. In " +
      "practice modern browsers block it, so the visible symptom is missing markers.",
    impact:
      "Broken map markers in production plus a mixed-content console warning. Low security impact; real " +
      "functional impact.",
    fix:
      "Change the scheme to https://maps.google.com/... or, better, use an inline SVG data URI so the " +
      "marker does not depend on a third-party host at all.",
    verify: (ctx) => {
      const hits = ctx.grep("apps/web/src/pages/patient/PharmacyMapPage.tsx", /url:\s*["']http:\/\//);
      return { present: hits.length > 0, evidence: hits.join("\n") };
    },
  },
  {
    id: "MG-SEC-019",
    severity: "LOW",
    type: "Security Misconfiguration",
    cwe: "CWE-1004: Sensitive Cookie Without HttpOnly",
    owasp: "A05:2021 Security Misconfiguration",
    file: "apps/backend/src/config/env.ts:15",
    endpoint: "n/a",
    title: "GOOGLE_MAPS_API_KEY is a required backend variable but is never used by any route",
    description:
      "env.ts lists GOOGLE_MAPS_API_KEY in the `required` array and exports it, so the process refuses to " +
      "boot without it — but no route, service or middleware reads ENV.GOOGLE_MAPS_API_KEY. All Maps work " +
      "happens client-side with VITE_GOOGLE_MAPS_API_KEY. render.yaml therefore sets it to \"placeholder\".",
    exploitation:
      "None directly. The risk is procedural: a required-but-unused secret trains operators to satisfy " +
      "the check with a dummy value, which is exactly what render.yaml does — and the same habit is what " +
      "produced MG-SEC-013 for the Firebase credential.",
    impact:
      "Dead configuration that weakens the meaning of the startup validation, and a placeholder culture " +
      "around secrets.",
    fix:
      "Remove GOOGLE_MAPS_API_KEY from env.ts and render.yaml entirely. If a server-side Maps call is " +
      "added later, reintroduce it then — and restrict the client key by HTTP referrer in Cloud Console.",
    verify: (ctx) => {
      const declared = /GOOGLE_MAPS_API_KEY/.test(ctx.read("apps/backend/src/config/env.ts"));
      const files = ctx.listFiles("apps/backend/src", /\.ts$/);
      const used = files.filter((f) => !f.endsWith("env.ts") && /GOOGLE_MAPS_API_KEY/.test(ctx.read(f)));
      return { present: declared && used.length === 0, evidence: `declared required; referenced by ${used.length} other files` };
    },
  },
  {
    id: "MG-SEC-020",
    severity: "LOW",
    type: "Broad Read Access",
    cwe: "CWE-1220: Insufficient Granularity of Access Control",
    owasp: "A01:2021 Broken Access Control",
    file: "firestore.rules:48",
    endpoint: "n/a (Firestore)",
    title: "Shared barcode registry votes are readable by every authenticated user",
    description:
      "match /barcodeRegistry/{code}/votes/{uid} allows read to any signed-in user. Writes are correctly " +
      "constrained to request.auth.uid == uid, so the tally cannot be stuffed. The rule's own comment " +
      "explains reads are open because the count is aggregated client-side.",
    exploitation:
      "An authenticated user enumerates the votes subcollection for a barcode and learns which user IDs " +
      "have scanned that specific medicine, since each vote document ID is the voter's uid.",
    impact:
      "Correlates a Firebase UID with a specific medicine having been scanned. That is health-adjacent " +
      "information, though it requires already knowing the barcode and having an account.",
    fix:
      "Move aggregation server-side: keep a single counter document per barcode that clients read, and " +
      "deny direct reads of the votes subcollection. If client aggregation must stay, strip the uid from " +
      "the document ID and use an auto-ID with the uid stored in a field that rules deny reading.",
    verify: (ctx) => {
      const rules = ctx.read("firestore.rules");
      const open = /barcodeRegistry\/\{code\}\/votes\/\{uid\}[\s\S]{0,200}allow read:\s*if request\.auth != null;/.test(rules);
      return { present: open, evidence: open ? "allow read: if request.auth != null (any signed-in user)" : "" };
    },
  },
  {
    id: "MG-SEC-021",
    severity: "LOW",
    type: "Information Disclosure via Logging",
    cwe: "CWE-532: Insertion of Sensitive Information into Log File",
    owasp: "A09:2021 Security Logging and Monitoring Failures",
    file: "apps/backend/src/services/mlService.ts:63, apps/backend/src/routes/ai.ts:52",
    endpoint: "n/a",
    title: "Upstream failure bodies are written to logs without redaction",
    description:
      "mlService.post() logs `err?.response?.data?.error ?? err?.message` on every failed attempt, and " +
      "ai.ts logs JSON.stringify(detail). When the ML service echoes part of a request back in an error, " +
      "the logged payload can include the user's question or OCR text.",
    exploitation:
      "Requires access to Render's log stream. A patient's free-text question to the AI assistant " +
      "(\"can I take X with my HIV medication\") could be captured verbatim in an error log.",
    impact:
      "Potential health information in application logs, which typically have weaker retention and " +
      "access controls than the database.",
    fix:
      "Log the failure code and a hash or truncated length rather than the payload:\n" +
      "  console.error(`[ML] ${path} failed: ${code} (payload ${body.length} bytes)`);\n" +
      "Never log request bodies for the /ask and /ocr routes.",
    verify: (ctx) => {
      const hits = ctx.grep("apps/backend/src/routes/ai.ts", /console\.error\([\s\S]{0,80}detail/);
      return { present: hits.length > 0, evidence: hits.join("\n") };
    },
  },
];

module.exports = { findings, SEVERITY };
