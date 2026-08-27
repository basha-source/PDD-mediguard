import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, FIRESTORE } from "@mediguard/shared";
import type { WellnessLog } from "@mediguard/shared";
import { getDb } from "@mediguard/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
} from "firebase/firestore";
import { useAuthStore } from "@/store/authStore";
import { callPatient, describeFirestoreError, fetchLinkedPatient, isCallable } from "@/utils/carePatient";

// ─── Constants ───────────────────────────────────────────────────────────────

const TEAL = "#00695C";

// ─── Types ────────────────────────────────────────────────────────────────────

type DoseEntry = {
  id: string;
  medicineName: string;
  scheduledTime: string; // "08:00"
  status: "taken" | "missed" | "pending" | "snoozed";
  takenAt?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** YYYY-MM-DD for `n` days before today, in the device's local calendar. */
function daysAgoString(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

/** Convert "08:00" → "8:00 AM" / "14:00" → "2:00 PM" */
function formatScheduledTime(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  const h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${period}`;
}

/** Convert ISO takenAt → "8:03 AM" */
function formatTakenAt(isoString: string): string {
  const d = new Date(isoString);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${period}`;
}

/** Derive today's date string for Firestore query */
function todayString(): string {
  return new Date().toISOString().split("T")[0]!;
}

/** Returns true if scheduledTime "HH:MM" was more than 30 minutes ago */
function isOverdue(scheduledTime: string): boolean {
  const [hStr, mStr] = scheduledTime.split(":");
  const now = new Date();
  const scheduled = new Date();
  scheduled.setHours(parseInt(hStr, 10), parseInt(mStr, 10), 0, 0);
  return now.getTime() - scheduled.getTime() > 30 * 60 * 1000;
}

/** Effective display status: treat overdue pending as missed */
function effectiveStatus(entry: DoseEntry): "taken" | "missed" | "pending" | "snoozed" {
  if (entry.status === "pending" && isOverdue(entry.scheduledTime)) return "missed";
  return entry.status;
}

/** Human-readable today label, e.g. "Today — Tuesday 27 May" */
function todayLabel(): string {
  return (
    "Today — " +
    new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    })
  );
}

// ─── Dose Card ────────────────────────────────────────────────────────────────

function DoseCard({ entry }: { entry: DoseEntry }) {
  const status = effectiveStatus(entry);

  const statusConfig = {
    taken: {
      icon: "✅",
      color: Colors.primary,
      label: entry.takenAt ? `Taken at ${formatTakenAt(entry.takenAt)}` : "Taken",
      badgeBg: Colors.primaryPale,
    },
    missed: {
      icon: "❌",
      color: Colors.alertRed,
      label: "Missed",
      badgeBg: Colors.redPale,
    },
    pending: {
      icon: "⏳",
      color: Colors.orange,
      label: "Pending",
      badgeBg: Colors.orangePale,
    },
    snoozed: {
      icon: "⏰",
      color: Colors.orange,
      label: "Snoozed",
      badgeBg: Colors.orangePale,
    },
  }[status];

  return (
    <View style={[s.card, status === "missed" && s.cardMissed]}>
      {/* Left: clock icon + time + medicine */}
      <View style={s.cardIconWrap}>
        <Ionicons name="time-outline" size={22} color={TEAL} />
      </View>
      <View style={s.cardBody}>
        <Text style={s.cardTime}>{formatScheduledTime(entry.scheduledTime)}</Text>
        <Text style={s.cardMedicine}>{entry.medicineName}</Text>
        {/* Status badge */}
        <View style={[s.badge, { backgroundColor: statusConfig.badgeBg }]}>
          <Text style={[s.badgeText, { color: statusConfig.color }]}>
            {statusConfig.icon} {statusConfig.label}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ─── Wellness ─────────────────────────────────────────────────────────────────

/** Filled/empty dots for a 1..5 rating. */
function Dots({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <View style={s.dotRow}>
      {Array.from({ length: max }, (_, i) => (
        <View key={i} style={[s.dot, { backgroundColor: i < value ? color : Colors.primaryPale }]} />
      ))}
    </View>
  );
}

function WellnessSection({ logs, error, patientName }: { logs: WellnessLog[]; error: string | null; patientName: string }) {
  const today   = todayString();
  const entry   = logs.find((l) => l.date === today);
  // Pain runs the other way to mood/energy: 0 is good, 10 is severe.
  const painCol = !entry ? Colors.textSecondary : entry.pain >= 7 ? Colors.alertRed : entry.pain >= 4 ? Colors.orange : Colors.primary;

  return (
    <View style={s.wellCard}>
      <View style={s.wellHead}>
        <Ionicons name="heart-outline" size={17} color={TEAL} />
        <Text style={s.wellTitle}>Today's Wellness</Text>
      </View>

      {error ? (
        <Text style={s.wellEmpty}>{error}</Text>
      ) : !entry ? (
        <Text style={s.wellEmpty}>
          {patientName} hasn't filled in today's wellness log yet.
        </Text>
      ) : (
        <>
          <View style={s.wellRow}>
            <Text style={s.wellLabel}>Mood</Text>
            <Dots value={entry.mood} max={5} color={Colors.primary} />
            <Text style={s.wellVal}>{entry.mood}/5</Text>
          </View>
          <View style={s.wellRow}>
            <Text style={s.wellLabel}>Energy</Text>
            <Dots value={entry.energy} max={5} color={Colors.orange} />
            <Text style={s.wellVal}>{entry.energy}/5</Text>
          </View>
          <View style={s.wellRow}>
            <Text style={s.wellLabel}>Pain</Text>
            <View style={s.painTrack}>
              <View style={[s.painFill, { width: `${(entry.pain / 10) * 100}%`, backgroundColor: painCol }]} />
            </View>
            <Text style={[s.wellVal, { color: painCol }]}>{entry.pain}/10</Text>
          </View>
          <View style={s.wellRow}>
            <Text style={s.wellLabel}>Sleep</Text>
            <View style={{ flex: 1 }} />
            <Text style={s.wellVal}>{entry.sleepHours} hrs</Text>
          </View>
          {!!entry.notes?.trim() && (
            <Text style={s.wellNote}>“{entry.notes.trim()}”</Text>
          )}
        </>
      )}

      {/* 7-day mood trend — a single day says little; the run is the signal. */}
      {!error && logs.length > 0 && (
        <>
          <View style={s.wellDivider} />
          <Text style={s.trendLabel}>Mood · last 7 days</Text>
          <View style={s.trendRow}>
            {Array.from({ length: 7 }, (_, i) => {
              const date = daysAgoString(6 - i);
              const log  = logs.find((l) => l.date === date);
              return (
                <View key={date} style={s.trendCol}>
                  <View style={s.trendTrack}>
                    <View
                      style={[
                        s.trendBar,
                        {
                          height: log ? `${(log.mood / 5) * 100}%` : 3,
                          backgroundColor: log ? Colors.primary : Colors.primaryPale,
                        },
                      ]}
                    />
                  </View>
                  <Text style={s.trendDay}>{date.slice(8)}</Text>
                </View>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export function CGPatientMonitorScreen() {
  const navigation = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  const [loading, setLoading] = useState(true);
  const [patientId, setPatientId] = useState<string | null>(null);
  const [patientName, setPatientName] = useState("Patient");
  const [patientPhone, setPatientPhone] = useState<string | undefined>(undefined);
  const [doseLogs, setDoseLogs] = useState<DoseEntry[]>([]);
  const [lastActive, setLastActive] = useState<string | null>(null);
  // Last 7 days of wellness, oldest first — the trend needs the run, not just today.
  const [wellness, setWellness] = useState<WellnessLog[]>([]);
  const [wellnessError, setWellnessError] = useState<string | null>(null);

  // ── Step 1: Fetch linked patient ──────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;

    let unsubscribeDoses: (() => void) | null = null;
    let unsubscribeWellness: (() => void) | null = null;

    async function fetchPatient() {
      try {
        const db = getDb();
        const linked = await fetchLinkedPatient(user!.id);

        if (!linked) {
          setPatientId(null);
          setLoading(false);
          return;
        }

        const linkedPatientId = linked.id;
        setPatientId(linkedPatientId);
        setPatientName(linked.name);
        setPatientPhone(linked.phone);

        // ── Step 2: Live dose logs for today ────────────────────────────────
        const today = todayString();
        unsubscribeDoses = onSnapshot(
          query(
            collection(db, FIRESTORE.DOSE_LOGS),
            where("userId", "==", linkedPatientId),
            where("date", "==", today)
          ),
          (snap) => {
            const logs = snap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Omit<DoseEntry, "id">),
            })) as DoseEntry[];

            // Sort by scheduledTime ascending
            logs.sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
            setDoseLogs(logs);

            // Compute lastActive from most recent takenAt
            const takenLogs = logs.filter((l) => l.takenAt);
            if (takenLogs.length > 0) {
              const latest = takenLogs.reduce((prev, cur) =>
                (cur.takenAt ?? "") > (prev.takenAt ?? "") ? cur : prev
              );
              setLastActive(latest.takenAt ?? null);
            }

            setLoading(false);
          },
          () => {
            setLoading(false);
          }
        );
        // ── Step 3: Last 7 days of wellness ─────────────────────────────────
        // Equality on userId + a range on date is exactly the existing
        // (userId ASC, date ASC) composite index, so no new index is needed.
        unsubscribeWellness = onSnapshot(
          query(
            collection(db, FIRESTORE.WELLNESS_LOGS),
            where("userId", "==", linkedPatientId),
            where("date", ">=", daysAgoString(6)),
            orderBy("date", "asc"),
          ),
          (snap) => {
            setWellness(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WellnessLog, "id">) })));
            setWellnessError(null);
          },
          (err) => {
            // An unreadable log is not an absent one — say so rather than
            // implying the patient simply never filled it in.
            console.warn("[CGPatientMonitor] wellness listener error:", err);
            setWellness([]);
            setWellnessError(describeFirestoreError(err));
          },
        );
      } catch {
        setLoading(false);
      }
    }

    fetchPatient();

    return () => {
      unsubscribeDoses?.();
      unsubscribeWellness?.();
    };
  }, [user?.id]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const lastActiveLabel = lastActive
    ? `Last active: ${getTimeAgo(lastActive)}`
    : "Last active: unknown";

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color={Colors.white} />
        </TouchableOpacity>
        <View style={s.headerTexts}>
          <Text style={s.headerTitle} numberOfLines={1}>
            {patientId ? `Monitoring: ${patientName}` : "No Patient Linked"}
          </Text>
          {patientId ? (
            <Text style={s.headerSubtitle}>{lastActiveLabel}</Text>
          ) : null}
        </View>
        {patientId ? (
          <TouchableOpacity
            style={[s.headerCallBtn, !isCallable(patientPhone) && s.headerCallBtnOff]}
            onPress={() => callPatient(patientPhone, patientName)}
            disabled={!isCallable(patientPhone)}
            activeOpacity={0.85}
          >
            <Ionicons name="call" size={18} color={Colors.white} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Body */}
      {loading ? (
        <View style={s.centered}>
          <ActivityIndicator size="large" color={TEAL} />
        </View>
      ) : !patientId ? (
        /* No patient state */
        <View style={s.centered}>
          <View style={s.emptyCard}>
            <Ionicons name="person-add-outline" size={48} color={Colors.textSecondary} />
            <Text style={s.emptyTitle}>No patient linked yet</Text>
            <Text style={s.emptyBody}>
              Ask your patient for their MG-XXXX code and link via Care Guardian Login.
            </Text>
          </View>
        </View>
      ) : (
        /* Dose list + button */
        <View style={s.listContainer}>
          <FlatList
            data={doseLogs}
            keyExtractor={(item) => item.id}
            contentContainerStyle={s.listContent}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={
              <>
                <WellnessSection logs={wellness} error={wellnessError} patientName={patientName} />
                <Text style={s.dateLabel}>{todayLabel()}</Text>
              </>
            }
            ListEmptyComponent={
              <View style={s.emptyCard}>
                <Ionicons name="calendar-outline" size={44} color={Colors.textSecondary} />
                <Text style={s.emptyTitle}>No doses scheduled today</Text>
                <Text style={s.emptyBody}>
                  Dose entries will appear here once the patient has medicines added.
                </Text>
              </View>
            }
            renderItem={({ item }) => <DoseCard entry={item} />}
          />

        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // Wellness
  wellCard:    { backgroundColor: Colors.card, borderRadius: 16, padding: 16, marginBottom: 18, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  wellHead:    { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 12 },
  wellTitle:   { fontSize: 15, fontWeight: "700", color: Colors.textPrimary },
  wellEmpty:   { fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },
  wellRow:     { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  wellLabel:   { fontSize: 13, color: Colors.textSecondary, width: 54 },
  wellVal:     { fontSize: 13, fontWeight: "700", color: Colors.textPrimary, minWidth: 52, textAlign: "right" },
  dotRow:      { flexDirection: "row", gap: 5, flex: 1 },
  dot:         { width: 13, height: 13, borderRadius: 7 },
  painTrack:   { flex: 1, height: 7, borderRadius: 4, backgroundColor: Colors.primaryPale, overflow: "hidden" },
  painFill:    { height: "100%", borderRadius: 4 },
  wellNote:    { fontSize: 12, fontStyle: "italic", color: Colors.textSecondary, marginTop: 4, lineHeight: 18 },
  wellDivider: { height: 1, backgroundColor: Colors.primaryPale, marginVertical: 14 },
  trendLabel:  { fontSize: 11, fontWeight: "600", color: Colors.textSecondary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 },
  trendRow:    { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  trendCol:    { flex: 1, alignItems: "center", gap: 5 },
  trendTrack:  { width: 16, height: 42, borderRadius: 5, backgroundColor: Colors.bg, justifyContent: "flex-end", overflow: "hidden" },
  trendBar:    { width: "100%", borderRadius: 5 },
  trendDay:    { fontSize: 10, color: Colors.textSecondary },

  root: {
    flex: 1,
    backgroundColor: Colors.bg,
  },

  // Header
  header: {
    backgroundColor: TEAL,
    paddingTop: 52,
    paddingBottom: 18,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  backBtn: {
    padding: 2,
  },
  headerTexts: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.white,
  },
  headerSubtitle: {
    fontSize: 12,
    color: "rgba(255,255,255,0.75)",
    marginTop: 2,
  },
  headerCallBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerCallBtnOff: {
    opacity: 0.4,
  },

  // Loading / empty
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  emptyCard: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 32,
    alignItems: "center",
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
    marginHorizontal: 16,
    marginTop: 16,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.textSecondary,
    textAlign: "center",
  },
  emptyBody: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 20,
  },

  // List
  listContainer: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 8,
  },
  dateLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textSecondary,
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },

  // Dose card
  card: {
    backgroundColor: Colors.card,
    borderRadius: 14,
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  cardMissed: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.alertRed,
  },
  cardIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: TEAL + "15",
    alignItems: "center",
    justifyContent: "center",
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  cardTime: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  cardMedicine: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  badge: {
    alignSelf: "flex-start",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginTop: 4,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
  },

});
