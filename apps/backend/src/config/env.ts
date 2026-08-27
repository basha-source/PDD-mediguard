import "dotenv/config";

const required = [
  "FIREBASE_SERVICE_ACCOUNT_KEY",
  "GOOGLE_MAPS_API_KEY",
] as const;

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables:\n${missing.join("\n")}\n\nCopy .env.example to .env and fill in the values.`);
}

export const ENV = {
  FIREBASE_SERVICE_ACCOUNT_KEY: process.env["FIREBASE_SERVICE_ACCOUNT_KEY"]!,
  GOOGLE_MAPS_API_KEY:          process.env["GOOGLE_MAPS_API_KEY"]!,
  ML_SERVICE_URL:               (process.env["ML_SERVICE_URL"] ?? "http://localhost:8000").replace(/\/+$/, ""),
  PORT:                         Number(process.env["PORT"] ?? 4000),

  // medicine.schedule times ("08:00") are wall-clock in the PATIENT's zone, but
  // Render runs UTC and most user docs have no `timezone` yet. This is the
  // fallback used when user.timezone is absent — our users are in India.
  DEFAULT_TIMEZONE:             process.env["DEFAULT_TIMEZONE"] ?? "Asia/Kolkata",

  // Shared secret for POST /api/notifications/scan-missed. That route writes
  // alerts and sends pushes, so it must not be publicly triggerable.
  //
  // There is deliberately NO fallback value. The previous default of
  // "dev-cron-secret" is published in this repository's git history, and
  // render.yaml declares CRON_SECRET with `sync: false` — so an operator who
  // applies the blueprint and skips that one prompt used to ship production
  // guarded by a secret anyone could read. (MG-SEC-001.)
  //
  // Undefined here means the route refuses every request rather than accepting
  // a known value; see routes/notifications.ts. Boot is intentionally NOT
  // blocked, because the missed-dose scan that matters runs on the in-process
  // timer and does not need this secret at all — only the manual trigger does.
  CRON_SECRET:                  process.env["CRON_SECRET"],

  // The in-process scan loop. Off under tests so importing index.ts never starts
  // a timer that keeps the process alive and hits Firestore.
  MISSED_DOSE_SCAN_ENABLED:     (process.env["MISSED_DOSE_SCAN_ENABLED"] ?? "true") === "true"
                                && process.env["NODE_ENV"] !== "test",
} as const;
