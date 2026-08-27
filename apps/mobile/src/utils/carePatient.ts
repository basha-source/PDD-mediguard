import { Alert, Linking } from "react-native";
import { collection, doc, getDoc, getDocs, limit, query, where } from "firebase/firestore";
import { getDb } from "@mediguard/firebase";
import { FIRESTORE } from "@mediguard/shared";
import type { User } from "@mediguard/shared";

// ─── Linked patient ───────────────────────────────────────────────────────────

export type LinkedPatient = {
  id:    string;
  name:  string;
  /** MG-XXXX code the guardian linked with. */
  code?: string;
  /** Patient's emergencyContact — the fallback number for the Call action. */
  phone?: string;
};

/**
 * Resolve the single patient this guardian is linked to, or null when unlinked.
 * One link per guardian today, so we take the first careGuardianLinks doc.
 */
export async function fetchLinkedPatient(guardianId: string): Promise<LinkedPatient | null> {
  const db = getDb();
  const links = await getDocs(
    query(
      collection(db, FIRESTORE.CG_LINKS),
      where("guardianId", "==", guardianId),
      limit(1),
    ),
  );

  const link      = links.docs[0]?.data();
  const patientId = link?.patientId as string | undefined;
  if (!patientId) return null;

  // The LINK is what makes a patient linked — reading their profile is only
  // enrichment (display name, phone for the Call action). That read can fail on
  // its own: the rule allowing it is isGuardianOf(), so any Console ruleset that
  // predates it returns permission-denied. Treating that as "no patient linked"
  // hid a link that had in fact been created, so it must degrade, not throw.
  let profile: Partial<User> | undefined;
  try {
    profile = (await getDoc(doc(db, FIRESTORE.USERS, patientId))).data() as Partial<User> | undefined;
  } catch {
    profile = undefined;
  }

  return {
    id:    patientId,
    name:  profile?.name ?? "Your patient",
    // The link doc records the code it was created with, so this survives even
    // when the patient's own document is unreadable.
    code:  (link?.code as string | undefined) ?? profile?.careGuardianCode,
    phone: profile?.emergencyContact,
  };
}

// ─── One-tap call ─────────────────────────────────────────────────────────────

/** tel: URLs choke on spaces, dashes and parentheses — keep digits and a leading +. */
function sanitize(raw?: string | null): string {
  const cleaned = (raw ?? "").replace(/[^\d+]/g, "");
  return cleaned.startsWith("+") ? "+" + cleaned.slice(1).replace(/\+/g, "") : cleaned.replace(/\+/g, "");
}

/** False when there is no usable number — call sites disable the button on this. */
export function isCallable(phone?: string | null): boolean {
  return sanitize(phone).replace("+", "").length >= 4;
}

/**
 * Dial the patient. Single call site for every "Call Patient" button so the
 * guard rails (missing number, no dialer, throwing openURL) behave identically
 * everywhere. A silent no-op on demo hardware looks broken, so every failure
 * path ends in a visible Alert.
 */
export async function callPatient(phone?: string | null, patientName = "Your patient"): Promise<void> {
  const number = sanitize(phone);

  if (!isCallable(number)) {
    Alert.alert(
      "No phone number saved",
      `${patientName} has no emergency contact on file. Ask them to add one in their MediGuard profile, then try again.`,
    );
    return;
  }

  const url = `tel:${number}`;
  // canOpenURL can report false on Android 11+ purely because the tel: scheme
  // is not declared in the manifest queries, so it gates the message we show
  // rather than the attempt itself.
  const supported = await Linking.canOpenURL(url).catch(() => false);

  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert(
      "Couldn't start the call",
      supported
        ? `Dial ${number} manually to reach ${patientName}.`
        : `This device can't place phone calls. Dial ${number} from another phone.`,
    );
  }
}

/**
 * Turn a Firestore read failure into something the guardian can act on.
 *
 * The two that actually occur here are configuration, not bugs: `permission-denied`
 * means firestore.rules has not been published to the Firebase Console, and
 * `failed-precondition` means the composite index the query needs is still
 * building. Both surface to the user as an empty screen, which in an adherence
 * app reads as "nothing was missed" — the opposite of the truth. So they must be
 * named, never swallowed.
 */
export function describeFirestoreError(err: unknown): string {
  const code = (err as { code?: string } | null | undefined)?.code ?? "";
  if (code === "permission-denied")
    return "Not allowed to read alerts yet — the MediGuard security rules still need to be published in the Firebase Console.";
  if (code === "failed-precondition")
    return "Alerts need a database index that is still being built. This usually clears within a few minutes.";
  if (code === "unavailable" || code === "deadline-exceeded")
    return "Can't reach the server. Check your internet connection.";
  return "Could not load alerts. Pull down to try again.";
}
