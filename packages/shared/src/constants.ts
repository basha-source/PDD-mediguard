export const API = {
  OPENFDA_BASE:  "https://api.fda.gov/drug",
  BACKEND_DEV:   "http://localhost:4000",
  BACKEND_PROD:  "https://api.mediguard.app",
} as const;

export const ALERT_DAYS = {
  EXPIRY_WARNING_1: 30,
  EXPIRY_WARNING_2: 7,
  EXPIRY_WARNING_3: 1,
  LOW_STOCK_THRESHOLD: 5,
} as const;

export const APP = {
  NAME:          "MediGuard",
  VERSION:       "1.0.0",
  TAGLINE:       "Your Personal Medicine Guardian",
} as const;

export const FIRESTORE = {
  USERS:         "users",
  MEDICINES:     "medicines",
  DOSE_LOGS:     "doseLogs",
  VITALS:        "vitals",
  VACCINATIONS:  "vaccinations",
  SIDE_EFFECTS:  "sideEffects",
  FAMILY:        "familyMembers",
  CG_LINKS:      "careGuardianLinks",
  NOTIFICATIONS: "notifications",
  CHAT_HISTORY:  "chatHistory",
  WELLNESS_LOGS: "wellnessLogs",
  // Private per-user barcode map: users/{uid}/barcodes/{code}
  BARCODES:         "barcodes",
  // Shared registry; votes live at barcodeRegistry/{code}/votes/{uid}
  BARCODE_REGISTRY: "barcodeRegistry",
  // Care Guardian: missed-dose alerts written by the backend cron, read by the guardian
  MISSED_DOSE_ALERTS: "missedDoseAlerts",
  // Public code -> patientId directory, doc ID *is* the MG-XXXX code. Rules cannot
  // authorise a query, so a guardian who only knows the code must be able to reach
  // the patient by a known document ID rather than by querying /users.
  PATIENT_CODES: "patientCodes",
} as const;

// Care Guardian missed-dose escalation.
export const CARE_GUARDIAN = {
  // A dose still un-taken this many minutes after its scheduled time is "missed"
  // and escalates to the linked guardian. One alert per dose, never repeated.
  GRACE_MINUTES: 5,
  // careGuardianLinks doc IDs are deterministic so security rules can prove a
  // link exists with a single exists() lookup instead of a query.
  linkId: (guardianId: string, patientId: string) => `${guardianId}_${patientId}`,
  // missedDoseAlerts doc IDs are deterministic so a re-run of the cron can never
  // create a second alert for the same dose.
  alertId: (patientId: string, medicineId: string, date: string, hhmm: string) =>
    `${patientId}_${medicineId}_${date}_${hhmm.replace(":", "")}`,
} as const;

export const STORAGE_PATHS = {
  PRESCRIPTIONS:  "prescriptions",
  PROFILE_PHOTOS: "profilePhotos",
  REPORTS:        "reports",
} as const;
