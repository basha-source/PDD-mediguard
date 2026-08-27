/**
 * Barcode → medicine registry.
 *
 * OpenFDA is the US NDC registry and UPCitemdb is a retail catalogue; an Indian
 * strip's EAN-13 is in neither. So for the medicines this app is actually used
 * with, `GET /lookup` returning 404 is the normal case, not the exception. The
 * user then reads the box (OCR) or types the name, and today that answer is
 * thrown away the moment the screen resets.
 *
 * This module keeps it. Every medicine the user confirms in AddMedicine is
 * written back against the barcode it came from, so the second scan of that box
 * resolves instantly -- no photo, no OCR, no network.
 *
 * Two layers, because one person's typo should not become another patient's
 * medicine name:
 *
 *   users/{uid}/barcodes/{code}        private, trusted immediately
 *   barcodeRegistry/{code}/votes/{uid} one vote per user, shared once
 *                                      PROMOTION_VOTES users independently agree
 *
 * Corrections fall out of the layout rather than needing their own path: both
 * writes are a `setDoc` at a deterministic id, so re-confirming a barcode with a
 * different name replaces the private entry and moves this user's vote off the
 * old value in the same operation.
 *
 * PRIVACY NOTE: vote documents carry a userId and are readable by any signed-in
 * user, because the count is aggregated on the client -- Firestore rules cannot
 * verify a tally the client computes. Someone who already knows a barcode can
 * therefore learn which users scanned it. Closing that properly needs a Cloud
 * Function holding the aggregate with votes kept private, which needs the
 * service-account credentials this project has not set up yet.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
} from "firebase/firestore";
import { getDb } from "@mediguard/firebase";
import { FIRESTORE, type MedicineCategory } from "@mediguard/shared";

export type BarcodeEntry = {
  name: string;
  dosage: string;
  category: MedicineCategory;
};

export type BarcodeHit = {
  entry: BarcodeEntry;
  /** "personal" = this user confirmed it before; "shared" = the crowd did. */
  source: "personal" | "shared";
};

/** Independent users who must agree before an entry is served to everyone. */
export const PROMOTION_VOTES = 3;

/**
 * Firestore document ids may not contain "/" and may not be "." or "..".
 * Barcode payloads are usually digits but a QR code can carry anything, so the
 * raw value is never used as an id directly.
 */
function codeId(barcode: string): string {
  return barcode.trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "_";
}

/** Groups votes that mean the same medicine despite case/spacing differences. */
function entryKey(entry: BarcodeEntry): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(entry.name)}|${norm(entry.dosage)}|${entry.category}`;
}

function personalRef(userId: string, barcode: string) {
  return doc(getDb(), FIRESTORE.USERS, userId, FIRESTORE.BARCODES, codeId(barcode));
}

function votesRef(barcode: string) {
  return collection(getDb(), FIRESTORE.BARCODE_REGISTRY, codeId(barcode), "votes");
}

function toEntry(data: Record<string, any> | undefined): BarcodeEntry | null {
  if (!data || typeof data.name !== "string" || !data.name.trim()) return null;
  return {
    name: data.name,
    dosage: typeof data.dosage === "string" ? data.dosage : "",
    category: (data.category ?? "other") as MedicineCategory,
  };
}

/**
 * A registry failure must never break a scan -- but it must not be invisible
 * either. A denied write and a genuinely unknown barcode produce exactly the
 * same screen, so swallowing the error turns a one-line configuration mistake
 * into a debugging session against the UI.
 *
 * permission-denied gets its own hint because in practice it means one thing:
 * the rules in firestore.rules were never deployed, so Firestore's default
 * deny is rejecting every read and write on these paths.
 */
function warn(op: string, err: any): void {
  const code = err?.code ?? err?.message ?? "unknown";
  const hint =
    err?.code === "permission-denied"
      ? " -- deploy the barcode rules in firestore.rules; Firestore is denying these paths by default."
      : "";
  console.warn(`[barcodeRegistry] ${op} failed (${code})${hint}`);
}

/**
 * Resolve a barcode from what we have learned, newest-trusted first.
 *
 * Returns null when nothing is known, which is the caller's signal to fall
 * through to OpenFDA/UPCitemdb and then to scanning the box.
 */
export async function lookupBarcode(
  userId: string,
  barcode: string,
): Promise<BarcodeHit | null> {
  // 1. This user already confirmed this exact box. Nothing outranks that.
  try {
    const snap = await getDoc(personalRef(userId, barcode));
    const entry = toEntry(snap.data());
    if (entry) return { entry, source: "personal" };
  } catch (err) {
    // Offline with nothing cached, or rules refused. Fall through -- a registry
    // miss must never be the reason a scan fails outright.
    warn("personal lookup", err);
  }

  // 2. Enough independent users agreed on the same answer.
  try {
    const votes = await getDocs(votesRef(barcode));
    const tally = new Map<string, { entry: BarcodeEntry; count: number }>();
    votes.forEach((v) => {
      const entry = toEntry(v.data());
      if (!entry) return;
      const key = entryKey(entry);
      const seen = tally.get(key);
      if (seen) seen.count += 1;
      else tally.set(key, { entry, count: 1 });
    });

    let best: { entry: BarcodeEntry; count: number } | null = null;
    tally.forEach((candidate) => {
      if (candidate.count >= PROMOTION_VOTES && (!best || candidate.count > best.count)) {
        best = candidate;
      }
    });
    if (best) return { entry: (best as { entry: BarcodeEntry }).entry, source: "shared" };
  } catch (err) {
    // Same reasoning as above.
    warn("shared lookup", err);
  }

  return null;
}

/**
 * Record that the user confirmed `entry` for `barcode`.
 *
 * Called after a successful save in AddMedicine, for every medicine that
 * carries a barcode -- including ones OpenFDA resolved, so repeat scans of
 * those stop hitting the network too.
 *
 * Deliberately does NOT store expiry: that is a property of the physical box,
 * not of the product, and caching it would prefill a stale date on the next
 * pack the user buys.
 *
 * Never throws. A registry write failing must not surface as "failed to save
 * medicine" when the medicine itself saved fine.
 */
export async function recordBarcode(
  userId: string,
  barcode: string,
  entry: BarcodeEntry,
): Promise<void> {
  if (!barcode.trim() || !entry.name.trim()) return;

  const payload = {
    name: entry.name.trim(),
    dosage: entry.dosage.trim(),
    category: entry.category,
    updatedAt: new Date().toISOString(),
  };

  // A fixed document id per (user, barcode) makes a re-confirmation overwrite
  // the previous answer instead of stacking a second one -- which is what makes
  // a correction actually correct, in both layers at once.
  const results = await Promise.allSettled([
    setDoc(personalRef(userId, barcode), payload),
    setDoc(doc(votesRef(barcode), userId), { ...payload, userId }),
  ]);
  results.forEach((r, i) => {
    if (r.status === "rejected") warn(i === 0 ? "personal write" : "vote write", r.reason);
  });
}
