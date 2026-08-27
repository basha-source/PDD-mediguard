import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// Whether we booted with a real service account. The missed-dose scan runs every
// minute, so without this flag a placeholder key would produce one credential
// stack trace per minute forever — it checks this and no-ops instead.
let credentialsConfigured = false;

function initAdmin(): App {
  if (getApps().length > 0) return getApps()[0]!;
  const raw = process.env["FIREBASE_SERVICE_ACCOUNT_KEY"];
  try {
    const serviceAccount = raw ? JSON.parse(raw) : null;
    if (serviceAccount?.project_id) {
      credentialsConfigured = true;
      return initializeApp({ credential: cert(serviceAccount) });
    }
  } catch {
    // service account key is not valid JSON (e.g. placeholder value)
  }
  // Fallback for local dev without a service account — auth operations will fail gracefully
  return initializeApp();
}

initAdmin();

export const adminAuth = getAuth();
export const adminDb   = getFirestore();
export const adminCredentialsConfigured = credentialsConfigured;
