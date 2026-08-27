// Expo inlines EXPO_PUBLIC_* variables into the JS bundle at BUILD time, but ONLY
// when they are referenced with STATIC member syntax — `process.env.EXPO_PUBLIC_FOO`.
// Dynamic access (`process.env[key]`) and, to be safe, bracket access are NOT
// reliably inlined and resolve to `undefined` in a release build. The previous
// version checked the vars via `process.env[key]`, so every one read as "missing"
// in the APK and the module threw at load → SIGABRT → black screen on launch.
//
// Every variable below is therefore read with static dot-notation, and the
// "missing" check is derived from those already-resolved values — never a dynamic
// lookup.

const FIREBASE_API_KEY             = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
const FIREBASE_AUTH_DOMAIN         = process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN;
const FIREBASE_PROJECT_ID          = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const FIREBASE_STORAGE_BUCKET      = process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET;
const FIREBASE_MESSAGING_SENDER_ID = process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
const FIREBASE_APP_ID              = process.env.EXPO_PUBLIC_FIREBASE_APP_ID;
const CONFIGURED_BACKEND_URL       = process.env.EXPO_PUBLIC_BACKEND_URL;

// ── Dev backend host resolution ──────────────────────────────────────────────
// On campus Wi-Fi the laptop's DHCP lease moves every few minutes, so a LAN IP
// hardcoded in .env goes stale almost immediately: the phone then dials a dead
// address, Android waits out its ~30s connect timeout, and the chat screen shows
// "I can't reach the assistant" after a long spin. Editing .env by hand each time
// is not a fix — the address is stale again before the next reload.
//
// Metro already knows the right address: the phone is talking to it over that
// exact host, so `Constants.expoConfig.hostUri` ("10.236.165.229:8081") is by
// definition reachable from the device. In dev we therefore keep only the PORT
// from the configured URL and take the HOST from Metro.
//
// A non-LAN URL (a deployed https:// backend) is always honoured as written —
// this rewrite only ever replaces a private-network address.
const DEV_BACKEND_PORT = 4000;

// A private/loopback host, i.e. one only reachable from the same network as
// this laptop. Parsed rather than pattern-matched: the octet ranges for the
// 172.16-31 block are far clearer as numbers than as a regex.
function isLanUrl(url: string): boolean {
  const afterScheme = url.includes("//") ? url.split("//")[1]! : url;
  const host = afterScheme.split(":")[0]!.split("/")[0]!;
  if (host === "localhost") return true;
  const o = host.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n))) return false;
  if (o[0] === 127 || o[0] === 10) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return o[0] === 172 && o[1]! >= 16 && o[1]! <= 31;
}

function resolveBackendUrl(): string | undefined {
  if (!__DEV__) return CONFIGURED_BACKEND_URL;
  // Only a LAN address (or a missing one) is worth overriding.
  if (CONFIGURED_BACKEND_URL && !isLanUrl(CONFIGURED_BACKEND_URL)) {
    return CONFIGURED_BACKEND_URL;
  }
  try {
    // Required lazily: this must never be the reason the module fails to load.
    const Constants = require("expo-constants").default;
    const hostUri: string | undefined =
      Constants?.expoConfig?.hostUri ?? Constants?.manifest2?.extra?.expoGo?.debuggerHost;
    const host = hostUri?.split(":")[0];
    if (host) {
      const url = `http://${host}:${DEV_BACKEND_PORT}`;
      if (url !== CONFIGURED_BACKEND_URL) {
        console.log(`[env] dev backend resolved from Metro: ${url}`);
      }
      return url;
    }
  } catch {
    // Fall through to the configured value — a stale IP still beats no value.
  }
  return CONFIGURED_BACKEND_URL;
}

const BACKEND_URL                  = resolveBackendUrl();

const resolved: Record<string, string | undefined> = {
  EXPO_PUBLIC_FIREBASE_API_KEY:             FIREBASE_API_KEY,
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN:         FIREBASE_AUTH_DOMAIN,
  EXPO_PUBLIC_FIREBASE_PROJECT_ID:          FIREBASE_PROJECT_ID,
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET:      FIREBASE_STORAGE_BUCKET,
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: FIREBASE_MESSAGING_SENDER_ID,
  EXPO_PUBLIC_FIREBASE_APP_ID:              FIREBASE_APP_ID,
  EXPO_PUBLIC_BACKEND_URL:                  BACKEND_URL,
};

const missing = Object.keys(resolved).filter((key) => !resolved[key]);
if (missing.length > 0) {
  // Do NOT throw — a throw during module load crashes a release build to a black
  // screen. Record it so ErrorBoundary can display which variables are missing.
  const msg = `Missing required environment variables:\n${missing.join("\n")}\n\nThese must be set in eas.json (build profile env) or .env.`;
  const g = globalThis as unknown as { __STARTUP_ERROR__?: string | null };
  g.__STARTUP_ERROR__ = g.__STARTUP_ERROR__ ? `${g.__STARTUP_ERROR__}\n\n${msg}` : msg;
  if (typeof console !== "undefined") console.error(msg);
}

export const ENV = {
  FIREBASE_API_KEY:             FIREBASE_API_KEY!,
  FIREBASE_AUTH_DOMAIN:         FIREBASE_AUTH_DOMAIN!,
  FIREBASE_PROJECT_ID:          FIREBASE_PROJECT_ID!,
  FIREBASE_STORAGE_BUCKET:      FIREBASE_STORAGE_BUCKET!,
  FIREBASE_MESSAGING_SENDER_ID: FIREBASE_MESSAGING_SENDER_ID!,
  FIREBASE_APP_ID:              FIREBASE_APP_ID!,
  BACKEND_URL:                  BACKEND_URL!,
  GOOGLE_WEB_CLIENT_ID:         process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? "",
  GOOGLE_ANDROID_CLIENT_ID:     process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? "",
} as const;
