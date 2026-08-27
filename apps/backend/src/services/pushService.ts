import axios from "axios";
import { FieldValue } from "firebase-admin/firestore";
import { FIRESTORE } from "@mediguard/shared";
import { adminDb } from "../config/firebaseAdmin";

/**
 * Expo push delivery.
 *
 * Nothing in here ever throws. Pushes are fired from the missed-dose scan, and a
 * dead token or an Expo outage must not abort a scan that has already written
 * the alert docs — the guardian still sees the alert in-app either way.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Expo's documented cap is 100 messages per request; more is rejected outright.
const BATCH_SIZE = 100;

// Expo is fast when healthy; a slow push must not hold the scan's event loop.
const PUSH_TIMEOUT_MS = 10_000;

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Owner of `to`. Carried so a DeviceNotRegistered ticket can clear the dead
   * token straight from the user doc instead of querying for it.
   */
  userId?: string;
};

type ExpoTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

// Expo rejects the WHOLE request with a 400 if any recipient is malformed, so
// junk tokens are dropped before they can take a good batch down with them.
function isExpoToken(token: unknown): token is string {
  return typeof token === "string" && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

/**
 * Drop a token Expo has told us is dead, so we stop retrying it every minute.
 * Deleting the field (rather than blanking it) keeps `user.pushToken` optional
 * exactly as the shared User type declares it.
 */
async function clearStaleToken(token: string, userId?: string): Promise<void> {
  try {
    if (userId) {
      await adminDb.collection(FIRESTORE.USERS).doc(userId).update({ pushToken: FieldValue.delete() });
      return;
    }
    // /send is called with a raw token and no uid, so fall back to a lookup.
    const snap = await adminDb.collection(FIRESTORE.USERS).where("pushToken", "==", token).get();
    await Promise.all(snap.docs.map((d) => d.ref.update({ pushToken: FieldValue.delete() })));
  } catch (e: any) {
    console.warn("[push] could not clear stale token:", e?.message ?? e);
  }
}

/**
 * Send a batch of pushes. Returns how many Expo accepted (an accepted ticket is
 * a queued push, not proof of delivery — that would need the receipts API).
 */
export async function sendExpoPushBatch(messages: ExpoPushMessage[]): Promise<number> {
  const valid = messages.filter((m) => isExpoToken(m.to));
  if (valid.length === 0) return 0;

  let accepted = 0;
  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const chunk = valid.slice(i, i + BATCH_SIZE);
    try {
      const { data } = await axios.post(
        EXPO_PUSH_URL,
        chunk.map((m) => ({
          to:    m.to,
          title: m.title,
          body:  m.body,
          data:  m.data ?? {},
          sound: "default",
          // Missed medication is time-critical: ask Android to wake the device.
          priority: "high",
        })),
        {
          timeout: PUSH_TIMEOUT_MS,
          headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip, deflate" },
        },
      );

      // Tickets come back positionally, so index i of the response is chunk[i].
      const tickets: ExpoTicket[] = Array.isArray(data?.data) ? data.data : [];
      for (let t = 0; t < chunk.length; t++) {
        const ticket = tickets[t];
        const msg    = chunk[t]!;
        if (!ticket) continue;                       // Expo returned a short list
        if (ticket.status === "ok") { accepted++; continue; }

        if (ticket.details?.error === "DeviceNotRegistered") {
          await clearStaleToken(msg.to, msg.userId);
        } else {
          console.warn(`[push] ticket error for ${msg.userId ?? "unknown user"}:`, ticket.details?.error ?? ticket.message);
        }
      }
    } catch (e: any) {
      // Transport/HTTP failure for the whole chunk — log and keep going so one
      // bad chunk does not cost us the rest of the batch.
      console.warn("[push] batch failed:", e?.response?.data?.errors?.[0]?.message ?? e?.message ?? e);
    }
  }
  return accepted;
}

/** Convenience wrapper for the single-recipient case. Resolves false on any failure. */
export async function sendExpoPush(
  token: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  userId?: string,
): Promise<boolean> {
  const sent = await sendExpoPushBatch([{ to: token, title, body, data, userId }]);
  return sent > 0;
}
