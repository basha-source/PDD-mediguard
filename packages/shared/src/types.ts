export type UserRole = "patient" | "careGuardian";

export type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  bloodGroup?: string;
  dateOfBirth?: string;
  gender?: string;
  allergies?: string[];
  conditions?: string[];
  emergencyContact?: string;
  careGuardianCode?: string;
  profilePhotoURL?: string;
  // Expo push token, saved on login so the backend can reach this device.
  pushToken?: string;
  // IANA zone (e.g. "Asia/Kolkata"). medicine.schedule times are wall-clock in
  // this zone; the backend falls back to DEFAULT_TIMEZONE when it is absent.
  timezone?: string;
  createdAt: string;
};

export type MedicineCategory = "tablet" | "capsule" | "liquid" | "injection" | "other";

export type Medicine = {
  id: string;
  userId: string;
  name: string;
  dosage: string;
  quantity: number;
  expiryDate: string;
  category: MedicineCategory;
  barcode?: string;
  prescribedBy?: string;
  schedule?: string;
  courseDays?: number;
  addedAt: string;
};

export type DoseStatus = "taken" | "missed" | "snoozed" | "pending";

export type DoseLog = {
  id: string;
  userId: string;
  medicineId: string;
  medicineName: string;
  scheduledTime: string;
  takenAt?: string;
  status: DoseStatus;
  reason?: string;
  date: string;
};

export type Vital = {
  id: string;
  userId: string;
  type: "bloodPressure" | "bloodSugar" | "temperature" | "weight";
  value: string;
  unit: string;
  status: "normal" | "borderline" | "high" | "low";
  recordedAt: string;
};

export type Vaccination = {
  id: string;
  userId: string;
  name: string;
  date: string;
  validUntil?: string;
  status: "completed" | "due" | "overdue";
};

export type SideEffect = {
  id: string;
  userId: string;
  medicineId: string;
  medicineName: string;
  symptoms: string[];
  severity: "mild" | "moderate" | "severe";
  startedAt: string;
  notes?: string;
};

export type FamilyMember = {
  id: string;
  parentUserId: string;
  name: string;
  relation: string;
  pin: string;
};

export type CareGuardianLink = {
  patientId: string;
  guardianId: string;
  code: string;
  linkedAt: string;
};

/**
 * One missed dose, escalated to the linked guardian.
 *
 * Written ONLY by the backend cron (via the Admin SDK, which bypasses rules).
 * The doc ID is deterministic — CARE_GUARDIAN.alertId() — so a re-run of the
 * scan can never raise a second alert for the same dose. Everything the
 * guardian needs to act is denormalised onto the doc, so the guardian never
 * has to read the patient's own medicine or doseLog records.
 */
export type MissedDoseAlert = {
  id: string;
  patientId: string;
  guardianId: string;
  patientName: string;
  /** Patient's emergencyContact, copied here to power the one-tap Call action. */
  patientPhone?: string;
  medicineId: string;
  medicineName: string;
  dosage?: string;
  /** ISO instant the dose was due. */
  scheduledTime: string;
  /** YYYY-MM-DD in the patient's own timezone. */
  date: string;
  /** ISO instant the scan flagged it. */
  detectedAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
};

export type Notification = {
  id: string;
  userId: string;
  title: string;
  body: string;
  type: "dose" | "expiry" | "refill" | "sos" | "careGuardian" | "wellness";
  read: boolean;
  createdAt: string;
  data?: {
    screen?: string;
    medicineId?: string;
    medicineName?: string;
  };
};

export type WellnessLog = {
  id: string;
  userId: string;
  date: string;          // YYYY-MM-DD, local timezone, one log per user per date
  mood: number;          // 1..5  (1 = very bad, 5 = very good)
  energy: number;        // 1..5
  pain: number;          // 0..10 (0 = none, 10 = severe)
  sleepHours: number;    // 0..24, may be fractional (e.g. 7.5)
  notes: string;         // "" if blank
  createdAt: string;     // ISO datetime
};
