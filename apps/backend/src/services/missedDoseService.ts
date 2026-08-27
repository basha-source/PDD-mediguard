import { CARE_GUARDIAN, FIRESTORE } from "@mediguard/shared";
import type { CareGuardianLink, DoseLog, Medicine, MissedDoseAlert, User } from "@mediguard/shared";
import { ENV } from "../config/env";
import { adminCredentialsConfigured, adminDb } from "../config/firebaseAdmin";
import { sendExpoPushBatch, type ExpoPushMessage } from "./pushService";

/**
 * Care Guardian missed-dose escalation.
 *
 * There are no "pending" doseLogs — a doseLogs row exists only once the patient
 * has acted. So an overdue dose is not a row we can query for; it is the ABSENCE
 * of a row. The scan therefore derives the day's due slots from the patient's
 * `medicines` schedules and checks each slot against the logs that do exist.
 *
 * The scan is driven from careGuardianLinks, not from users: a patient with no
 * guardian has nobody to escalate to, so scanning them would be pure cost.
 */

const GRACE_MS = CARE_GUARDIAN.GRACE_MINUTES * 60_000;

/**
 * Slots older than this are ignored entirely.
 *
 * Without it, the very first deploy (and any restart after downtime) would walk
 * every historical schedule slot still inside the scan window and fire a flood
 * of alerts for doses the guardian can no longer do anything about. 12h is wide
 * enough that a few hours of downtime still escalates, narrow enough that a
 * cold start never spams a phone with yesterday morning's doses.
 */
const MAX_BACKFILL_MS = 12 * 60 * 60_000;

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type MissedDoseScanSummary = {
  /** careGuardianLinks examined this tick. */
  scanned: number;
  alertsCreated: number;
  pushesSent: number;
};

// ─── Timezone plumbing ───────────────────────────────────────────────────────
// Render runs UTC but "08:00" in a schedule is wall-clock in the PATIENT's zone.
// Intl is the only zone database we need, so no date library is pulled in.

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const zoneValidCache = new Map<string, boolean>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",           // keeps midnight as "00", never "24"
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** user.timezone is user-supplied and mostly absent; a bad value must not throw. */
function resolveZone(timezone?: string): string {
  if (!timezone) return ENV.DEFAULT_TIMEZONE;
  let valid = zoneValidCache.get(timezone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      valid = true;
    } catch {
      valid = false;
      console.warn(`[missedDose] unknown timezone "${timezone}" — using ${ENV.DEFAULT_TIMEZONE}`);
    }
    zoneValidCache.set(timezone, valid);
  }
  return valid ? timezone : ENV.DEFAULT_TIMEZONE;
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsInZone(at: Date, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(at)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year:   out["year"]   ?? 0, month:  out["month"]  ?? 1, day:    out["day"]    ?? 1,
    hour:   out["hour"]   ?? 0, minute: out["minute"] ?? 0, second: out["second"] ?? 0,
  };
}

/**
 * Offset of `timeZone` at instant `at`, in ms east of UTC.
 *
 * Trick: render the instant as wall-clock in the zone, then re-read those same
 * fields as if they were UTC — the difference IS the offset, DST included.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = partsInZone(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime();
}

/** "2026-08-26" + "08:00" in Asia/Kolkata -> the UTC instant that dose is due. */
function wallClockToUtc(dateStr: string, hhmm: string, timeZone: string): Date {
  const wallAsUtc = Date.parse(`${dateStr}T${hhmm}:00Z`);
  // First guess uses the offset at the wall-clock instant; one correction pass
  // then fixes the rare case where that guess landed on the far side of a DST
  // transition. (Asia/Kolkata has no DST at all, so this is belt-and-braces.)
  const guess = new Date(wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone));
  return new Date(wallAsUtc - zoneOffsetMs(guess, timeZone));
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** YYYY-MM-DD as the patient's own calendar sees it — this is doseLog.date. */
function localDateStr(at: Date, timeZone: string): string {
  const p = partsInZone(at, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/**
 * HH:MM of an ISO instant in the patient's zone.
 *
 * The phone writes scheduledTime by building a Date from local wall-clock and
 * calling toISOString(), then matches with getHHMM() in its own local zone. So
 * reading it back in the patient's zone reproduces exactly the HH:MM the mobile
 * matcher would compute — reading it in UTC would not.
 */
function hhmmInZone(iso: string, timeZone: string): string {
  const p = partsInZone(new Date(iso), timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function shiftDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function format12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h ?? 0;
  const ampm = hour >= 12 ? "PM" : "AM";
  return `${pad2(hour % 12 === 0 ? 12 : hour % 12)}:${pad2(m ?? 0)} ${ampm}`;
}

// ─── Schedule expansion ──────────────────────────────────────────────────────

/**
 * medicine.schedule is a JSON *string* — `{"times":["08:00","20:00"], ...}`.
 * Mirrors parseSchedule() in DoseTrackerScreen; absent/empty/unparseable means
 * the medicine has no reminder set, which is not a missed dose.
 */
function parseScheduleTimes(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.times)) return [];
    return parsed.times.filter((t: unknown): t is string => typeof t === "string" && TIME_REGEX.test(t));
  } catch {
    return [];
  }
}

export type DueSlot = { medicine: Medicine; date: string; hhmm: string; scheduledAt: Date };

export function expandDueSlots(medicines: Medicine[], now: Date, timeZone: string): DueSlot[] {
  const today = localDateStr(now, timeZone);
  // Yesterday is included because a late-evening dose (say 23:58) only becomes
  // missed after midnight, by which point "today" no longer contains its slot.
  // MAX_BACKFILL_MS keeps this from actually widening the scan.
  const dates = [shiftDateStr(today, -1), today];

  const slots: DueSlot[] = [];
  for (const medicine of medicines) {
    for (const hhmm of parseScheduleTimes(medicine.schedule)) {
      for (const date of dates) {
        const scheduledAt = wallClockToUtc(date, hhmm, timeZone);
        const ageMs = now.getTime() - scheduledAt.getTime();
        if (ageMs < GRACE_MS)        continue;   // in the future, or still inside the grace period
        if (ageMs > MAX_BACKFILL_MS) continue;   // too old to be actionable
        slots.push({ medicine, date, hhmm, scheduledAt });
      }
    }
  }
  return slots;
}

// ─── The scan ────────────────────────────────────────────────────────────────

export async function scanForMissedDoses(now: Date = new Date()): Promise<MissedDoseScanSummary> {
  const summary: MissedDoseScanSummary = { scanned: 0, alertsCreated: 0, pushesSent: 0 };

  // Local dev boots the Admin SDK with no service account (see firebaseAdmin.ts).
  // Every Firestore call would then reject on credentials, once a minute, forever.
  if (!adminCredentialsConfigured) {
    console.warn("[missedDose] no Firebase service account configured — scan skipped");
    return summary;
  }

  const pushes: ExpoPushMessage[] = [];
  const guardianCache = new Map<string, User | null>();   // one read per guardian per scan

  try {
    const linksSnap = await adminDb.collection(FIRESTORE.CG_LINKS).get();
    summary.scanned = linksSnap.size;

    for (const linkDoc of linksSnap.docs) {
      const link = linkDoc.data() as CareGuardianLink;
      if (!link?.patientId || !link?.guardianId) continue;

      try {
        const patientSnap = await adminDb.collection(FIRESTORE.USERS).doc(link.patientId).get();
        if (!patientSnap.exists) continue;
        const patient = { id: patientSnap.id, ...patientSnap.data() } as User;
        const zone = resolveZone(patient.timezone);

        const medsSnap = await adminDb.collection(FIRESTORE.MEDICINES)
          .where("userId", "==", link.patientId).get();
        const medicines = medsSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as Medicine);

        const slots = expandDueSlots(medicines, now, zone);
        if (slots.length === 0) continue;

        // Only the dates the surviving slots actually touch — usually just today.
        const dates = [...new Set(slots.map((s) => s.date))];
        const logsSnap = await adminDb.collection(FIRESTORE.DOSE_LOGS)
          .where("userId", "==", link.patientId)
          .where("date", "in", dates)
          .get();

        // A slot is answered by (medicineId, date, HH:MM) — the same key
        // DoseTrackerScreen matches on. "missed" and "pending" rows are NOT
        // answers: the patient still has not taken it, which is the whole point.
        const answered = new Set<string>();
        for (const d of logsSnap.docs) {
          const log = d.data() as DoseLog;
          if (log.status !== "taken" && log.status !== "snoozed") continue;
          answered.add(`${log.medicineId}|${log.date}|${hhmmInZone(log.scheduledTime, zone)}`);
        }

        for (const slot of slots) {
          if (answered.has(`${slot.medicine.id}|${slot.date}|${slot.hhmm}`)) continue;

          const alertId = CARE_GUARDIAN.alertId(link.patientId, slot.medicine.id, slot.date, slot.hhmm);
          const alert: MissedDoseAlert = {
            id:            alertId,
            patientId:     link.patientId,
            guardianId:    link.guardianId,
            patientName:   patient.name ?? "Patient",
            medicineId:    slot.medicine.id,
            medicineName:  slot.medicine.name ?? "medicine",
            scheduledTime: slot.scheduledAt.toISOString(),
            date:          slot.date,
            detectedAt:    now.toISOString(),
            acknowledged:  false,
            // Denormalised so the guardian can call without reading patient data
            // (their rules grant them the alert doc only). Spread-guarded because
            // Firestore rejects an explicit `undefined` value.
            ...(patient.emergencyContact ? { patientPhone: patient.emergencyContact } : {}),
            ...(slot.medicine.dosage     ? { dosage: slot.medicine.dosage }           : {}),
          };

          try {
            // create() — NOT set(). The doc id is deterministic, so a second
            // attempt for the same dose fails with ALREADY_EXISTS instead of
            // overwriting. That is what makes "one alert per dose, never
            // repeated" true even if two ticks overlap or the service restarts.
            await adminDb.collection(FIRESTORE.MISSED_DOSE_ALERTS).doc(alertId).create(alert);
          } catch (e: any) {
            // gRPC code 6 = ALREADY_EXISTS: this dose was escalated already.
            if (e?.code === 6) continue;
            console.warn(`[missedDose] alert write failed (${alertId}):`, e?.message ?? e);
            continue;
          }
          summary.alertsCreated++;

          // Only reached when the create won, so a guardian is pushed exactly once.
          let guardian = guardianCache.get(link.guardianId);
          if (guardian === undefined) {
            const gSnap = await adminDb.collection(FIRESTORE.USERS).doc(link.guardianId).get();
            guardian = gSnap.exists ? ({ id: gSnap.id, ...gSnap.data() } as User) : null;
            guardianCache.set(link.guardianId, guardian);
          }
          if (!guardian?.pushToken) continue;

          pushes.push({
            to:     guardian.pushToken,
            title:  "Missed dose",
            body:   `${alert.patientName} has not taken ${alert.medicineName}${alert.dosage ? ` (${alert.dosage})` : ""}, due at ${format12h(slot.hhmm)}.`,
            userId: link.guardianId,
            data:   { screen: "CGAlert", alertId, patientId: link.patientId, medicineId: slot.medicine.id },
          });
        }
      } catch (e: any) {
        // One broken patient must not cost every other guardian their alerts.
        console.warn(`[missedDose] link ${linkDoc.id} failed:`, e?.message ?? e);
      }
    }

    // Batched at the end so many guardians cost one Expo round trip, not N.
    summary.pushesSent = await sendExpoPushBatch(pushes);
  } catch (e: any) {
    console.error("[missedDose] scan aborted:", e?.message ?? e);
  }

  if (summary.alertsCreated > 0 || summary.pushesSent > 0) {
    console.log(`[missedDose] scanned=${summary.scanned} alerts=${summary.alertsCreated} pushes=${summary.pushesSent}`);
  }
  return summary;
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 60_000;   // GRACE_MINUTES is 5, so once a minute is ample resolution
let scanning = false;

/**
 * In-process loop rather than a cron provider: this is a single always-on Render
 * web service, so a timer costs nothing and needs no second deploy target. A
 * separate cron would also have to re-boot the Admin SDK on every tick, and
 * Render's free cron granularity does not go below a minute anyway.
 */
export function startMissedDoseScanner(): void {
  const tick = async () => {
    if (scanning) return;   // a slow scan must not pile ticks up behind it
    scanning = true;
    try { await scanForMissedDoses(); } finally { scanning = false; }
  };
  const timer = setInterval(tick, SCAN_INTERVAL_MS);
  timer.unref?.();          // never hold the process open on shutdown
  console.log(`[missedDose] scanner started (every ${SCAN_INTERVAL_MS / 1000}s, grace ${CARE_GUARDIAN.GRACE_MINUTES}m)`);
}
