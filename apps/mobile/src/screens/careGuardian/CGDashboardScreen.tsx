import { useEffect, useState } from "react";
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, FIRESTORE } from "@mediguard/shared";
import type { DoseLog, MissedDoseAlert } from "@mediguard/shared";
import { getDb } from "@mediguard/firebase";
import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { BannerCarousel } from "@/components/common/BannerCarousel";
import type { BannerSlide } from "@/components/common/BannerCarousel";
import { useDrawer } from "@/navigation/drawerContext";
import { useAuthStore } from "@/store/authStore";
import { callPatient, describeFirestoreError, fetchLinkedPatient, isCallable } from "@/utils/carePatient";
import type { LinkedPatient } from "@/utils/carePatient";

const TEAL = "#00695C";
const RECENT_ALERTS = 3;

const CG_SLIDES: BannerSlide[] = [
  {
    id:       "monitor",
    image:    "https://images.unsplash.com/photo-1576765608535-5f04d1e3f289?w=700&q=80",
    color:    "#004D40",
    icon:     "people-outline",
    title:    "Monitor Loved Ones",
    subtitle: "Track medicine adherence in real time",
  },
  {
    id:       "alerts",
    image:    "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=700&q=80",
    color:    "#B71C1C",
    icon:     "notifications-outline",
    title:    "Instant Alerts",
    subtitle: "Get notified immediately when doses are missed",
  },
  {
    id:       "reports",
    image:    "https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=700&q=80",
    color:    "#1A237E",
    icon:     "bar-chart-outline",
    title:    "Adherence Reports",
    subtitle: "View weekly health summaries and trends",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().split("T")[0]!;
}

/** ISO instant → "8:00 AM". */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CGDashboardScreen() {
  const { openDrawer } = useDrawer();
  const navigation     = useNavigation<any>();
  // Re-subscribe on focus so returning from Link Patient shows the new patient.
  const isFocused      = useIsFocused();
  const user           = useAuthStore((s) => s.user);

  const [patient, setPatient] = useState<LinkedPatient | null>(null);
  const [doses,   setDoses]   = useState<DoseLog[]>([]);
  const [alerts,  setAlerts]  = useState<MissedDoseAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [dosesError,  setDosesError]  = useState<string | null>(null);

  const initials    = (user?.name ?? "CG").slice(0, 2).toUpperCase();
  const takenCount  = doses.filter((d) => d.status === "taken").length;
  const phone       = patient?.phone;
  const canCall     = isCallable(phone);

  // ── Linked patient → today's doses + latest missed-dose alerts ─────────────
  useEffect(() => {
    const uid = user?.id;
    if (!uid) return;

    let cancelled     = false;
    let unsubDoses:  (() => void) | undefined;
    let unsubAlerts: (() => void) | undefined;

    const db = getDb();

    // Ordered read needs the (guardianId, detectedAt desc) composite index; while
    // that builds, fall back to a plain equality query and sort/slice here.
    const take = (docs: { id: string; data: () => Record<string, unknown> }[]) =>
      docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<MissedDoseAlert, "id">) }))
        .sort((a, b) => (b.detectedAt ?? "").localeCompare(a.detectedAt ?? ""))
        .slice(0, RECENT_ALERTS);

    const subscribeAlerts = (ordered: boolean) => onSnapshot(
      ordered
        ? query(collection(db, FIRESTORE.MISSED_DOSE_ALERTS), where("guardianId", "==", uid), orderBy("detectedAt", "desc"), limit(RECENT_ALERTS))
        : query(collection(db, FIRESTORE.MISSED_DOSE_ALERTS), where("guardianId", "==", uid), limit(50)),
      (snap) => {
        setAlerts(take(snap.docs));
        setAlertsError(null);
      },
      (err) => {
        if (ordered && (err as { code?: string })?.code === "failed-precondition") {
          unsubAlerts?.();
          unsubAlerts = subscribeAlerts(false);
          return;
        }
        // Swallowing this would paint the "no missed doses" all-clear card over a
        // feed we could not actually read — the one lie this screen must not tell.
        console.warn("[CGDashboard] alerts listener error:", err);
        setAlerts([]);
        setAlertsError(describeFirestoreError(err));
      },
    );

    unsubAlerts = subscribeAlerts(true);

    (async () => {
      const linked = await fetchLinkedPatient(uid).catch(() => null);
      if (cancelled) return;
      setPatient(linked);

      if (!linked) {
        setLoading(false);
        return;
      }

      unsubDoses = onSnapshot(
        query(
          collection(db, FIRESTORE.DOSE_LOGS),
          where("userId", "==", linked.id),
          where("date", "==", todayString()),
        ),
        (snap) => {
          setDoses(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DoseLog, "id">) })));
          setDosesError(null);
          setLoading(false);
        },
        (err) => {
          // Same trap as the alerts feed: an unreadable dose log is not an empty
          // one, and "No doses scheduled today" would be a flat untruth.
          console.warn("[CGDashboard] doseLogs listener error:", err);
          setDoses([]);
          setDosesError(describeFirestoreError(err));
          setLoading(false);
        },
      );
    })();

    return () => {
      cancelled = true;
      unsubDoses?.();
      unsubAlerts?.();
    };
  }, [user?.id, isFocused]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ScrollView style={s.root} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.menuBtn} onPress={openDrawer} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="menu" size={26} color={Colors.white} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.greeting}>Welcome back 👋</Text>
          <Text style={s.title}>CareGuardian</Text>
        </View>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{initials}</Text>
        </View>
      </View>

      {/* Sliding Banner */}
      <BannerCarousel slides={CG_SLIDES} />

      {loading ? (
        <View style={s.loading}>
          <ActivityIndicator size="large" color={TEAL} />
        </View>
      ) : !patient ? (
        /* ── Empty state: nobody linked ── */
        <View style={s.emptyCard}>
          <View style={s.emptyIcon}>
            <Ionicons name="person-add-outline" size={34} color={TEAL} />
          </View>
          <Text style={s.emptyTitle}>No patient linked yet</Text>
          <Text style={s.emptyBody}>
            Ask your patient to open MediGuard {"→"} Profile and read out their{" "}
            <Text style={s.emptyCode}>MG-XXXX</Text> code, then tap the button below
            to start monitoring them.
          </Text>
          <TouchableOpacity
            style={s.linkBtn}
            onPress={() => navigation.navigate("LinkPatient")}
            activeOpacity={0.85}
          >
            <Ionicons name="qr-code-outline" size={17} color={Colors.white} />
            <Text style={s.linkBtnTxt}>Link a Patient</Text>
          </TouchableOpacity>

          <View style={s.emptySteps}>
            {["Get their MG-XXXX code", "Tap Link a Patient, enter it", "Missed doses alert you here"].map((step, i) => (
              <View key={step} style={s.stepRow}>
                <View style={s.stepDot}><Text style={s.stepNum}>{i + 1}</Text></View>
                <Text style={s.stepTxt}>{step}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <>
          {/* ── Linked patient ── */}
          <Text style={s.sectionTitle}>Monitored Patient</Text>
          <View style={s.patientCard}>
            <View style={s.patientTop}>
              <View style={s.patientAvatar}>
                <Text style={s.patientInitials}>{patient.name.slice(0, 2).toUpperCase()}</Text>
              </View>
              <View style={s.patientTexts}>
                <Text style={s.patientName} numberOfLines={1}>{patient.name}</Text>
                <View style={s.codeChip}>
                  <Ionicons name="qr-code-outline" size={11} color={TEAL} />
                  <Text style={s.codeTxt}>{patient.code ?? "Linked"}</Text>
                </View>
              </View>
              <TouchableOpacity
                style={[s.callBtn, !canCall && s.callBtnOff]}
                onPress={() => callPatient(phone, patient.name)}
                disabled={!canCall}
                activeOpacity={0.85}
              >
                <Ionicons name="call" size={17} color={Colors.white} />
                <Text style={s.callTxt}>Call</Text>
              </TouchableOpacity>
            </View>

            {!canCall && (
              <Text style={s.callHint}>
                No emergency contact saved — ask {patient.name} to add one to enable calling.
              </Text>
            )}

            {/* Today's adherence */}
            <View style={s.divider} />
            <View style={s.adherenceRow}>
              <Ionicons
                name={dosesError ? "cloud-offline-outline" : doses.length > 0 && takenCount === doses.length ? "checkmark-circle" : "time-outline"}
                size={18}
                color={dosesError ? Colors.alertRed : doses.length > 0 && takenCount === doses.length ? Colors.primary : Colors.orange}
              />
              <Text style={s.adherenceTxt}>
                {dosesError
                  ? "Today's doses unavailable"
                  : doses.length === 0
                  ? "No doses scheduled today"
                  : `${takenCount} of ${doses.length} dose${doses.length === 1 ? "" : "s"} taken today`}
              </Text>
              <TouchableOpacity onPress={() => navigation.navigate("PatientMonitor")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={s.link}>Details</Text>
              </TouchableOpacity>
            </View>
            {!dosesError && doses.length > 0 && (
              <View style={s.track}>
                <View style={[s.fill, { width: `${Math.round((takenCount / doses.length) * 100)}%` }]} />
              </View>
            )}
          </View>

          {/* ── Recent missed doses ── */}
          <View style={s.sectionRow}>
            <Text style={s.sectionTitle}>Recent Missed Doses</Text>
            {alerts.length > 0 && (
              <TouchableOpacity onPress={() => navigation.navigate("Alerts")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={[s.link, s.linkPad]}>View all</Text>
              </TouchableOpacity>
            )}
          </View>

          {alertsError ? (
            <View style={s.calmCard}>
              <Ionicons name="cloud-offline-outline" size={26} color={Colors.alertRed} />
              <View style={s.calmTexts}>
                <Text style={s.calmTitle}>Alerts unavailable</Text>
                <Text style={s.calmBody}>{alertsError}</Text>
              </View>
            </View>
          ) : alerts.length === 0 ? (
            <View style={s.calmCard}>
              <Ionicons name="shield-checkmark-outline" size={26} color={Colors.primary} />
              <View style={s.calmTexts}>
                <Text style={s.calmTitle}>No missed doses</Text>
                <Text style={s.calmBody}>You'll be alerted 5 minutes after a dose is missed.</Text>
              </View>
            </View>
          ) : (
            alerts.map((a) => (
              <TouchableOpacity
                key={a.id}
                style={[s.alertCard, !a.acknowledged && s.alertCardUnread]}
                onPress={() => navigation.navigate("Alerts")}
                activeOpacity={0.75}
              >
                <View style={s.alertIcon}>
                  <Ionicons name="close-circle" size={22} color={Colors.alertRed} />
                </View>
                <View style={s.alertTexts}>
                  <Text style={s.alertMed} numberOfLines={1}>
                    {a.medicineName}{a.dosage ? ` · ${a.dosage}` : ""}
                  </Text>
                  <Text style={s.alertMeta}>
                    Due {formatTime(a.scheduledTime)} · missed {timeAgo(a.detectedAt)}
                  </Text>
                </View>
                {!a.acknowledged && <View style={s.unreadDot} />}
                <Ionicons name="chevron-forward" size={16} color={Colors.textSecondary} />
              </TouchableOpacity>
            ))
          )}
        </>
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root:           { flex: 1, backgroundColor: Colors.bg },

  // Header
  header:         { backgroundColor: TEAL, paddingTop: 48, paddingBottom: 20, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  menuBtn:        { padding: 4 },
  headerCenter:   { flex: 1, alignItems: "center" },
  greeting:       { fontSize: 12, color: "rgba(255,255,255,0.75)" },
  title:          { fontSize: 20, fontWeight: "700", color: Colors.white },
  avatar:         { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.25)", alignItems: "center", justifyContent: "center" },
  avatarText:     { fontSize: 14, fontWeight: "700", color: Colors.white },

  loading:        { paddingVertical: 64, alignItems: "center" },
  sectionTitle:   { fontSize: 15, fontWeight: "600", color: Colors.textPrimary, marginHorizontal: 16, marginTop: 20, marginBottom: 10 },
  sectionRow:     { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  link:           { fontSize: 12, fontWeight: "700", color: TEAL },
  linkPad:        { marginRight: 16, marginTop: 10 },

  // Patient card
  patientCard:    { backgroundColor: Colors.card, marginHorizontal: 16, borderRadius: 16, padding: 16, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  patientTop:     { flexDirection: "row", alignItems: "center", gap: 12 },
  patientAvatar:  { width: 48, height: 48, borderRadius: 24, backgroundColor: TEAL + "18", alignItems: "center", justifyContent: "center" },
  patientInitials:{ fontSize: 16, fontWeight: "700", color: TEAL },
  patientTexts:   { flex: 1, gap: 5 },
  patientName:    { fontSize: 16, fontWeight: "700", color: Colors.textPrimary },
  codeChip:       { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: TEAL + "12", borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  codeTxt:        { fontSize: 11, fontWeight: "700", color: TEAL, letterSpacing: 0.4 },
  callBtn:        { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: TEAL, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10 },
  callBtnOff:     { backgroundColor: "#B0BEC5" },
  callTxt:        { fontSize: 13, fontWeight: "700", color: Colors.white },
  callHint:       { fontSize: 11, color: Colors.textSecondary, marginTop: 10, lineHeight: 16 },

  divider:        { height: 1, backgroundColor: "rgba(0,0,0,0.06)", marginVertical: 14 },
  adherenceRow:   { flexDirection: "row", alignItems: "center", gap: 8 },
  adherenceTxt:   { flex: 1, fontSize: 13, fontWeight: "600", color: Colors.textPrimary },
  track:          { height: 6, borderRadius: 3, backgroundColor: "rgba(0,0,0,0.06)", marginTop: 10, overflow: "hidden" },
  fill:           { height: 6, borderRadius: 3, backgroundColor: Colors.primary },

  // Missed-dose rows
  alertCard:      { backgroundColor: Colors.card, marginHorizontal: 16, marginBottom: 10, borderRadius: 16, padding: 14, flexDirection: "row", alignItems: "center", gap: 12, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  alertCardUnread:{ borderLeftWidth: 3, borderLeftColor: Colors.alertRed },
  alertIcon:      { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.redPale, alignItems: "center", justifyContent: "center" },
  alertTexts:     { flex: 1, gap: 3 },
  alertMed:       { fontSize: 14, fontWeight: "700", color: Colors.textPrimary },
  alertMeta:      { fontSize: 11, color: Colors.textSecondary },
  unreadDot:      { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.alertRed },

  // All-clear card
  calmCard:       { backgroundColor: Colors.card, marginHorizontal: 16, borderRadius: 16, padding: 16, flexDirection: "row", alignItems: "center", gap: 14, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  calmTexts:      { flex: 1, gap: 3 },
  calmTitle:      { fontSize: 14, fontWeight: "700", color: Colors.textPrimary },
  calmBody:       { fontSize: 12, color: Colors.textSecondary, lineHeight: 17 },

  // Empty state
  emptyCard:      { backgroundColor: Colors.card, marginHorizontal: 16, marginTop: 24, borderRadius: 16, padding: 24, alignItems: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  emptyIcon:      { width: 64, height: 64, borderRadius: 32, backgroundColor: TEAL + "14", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  emptyTitle:     { fontSize: 16, fontWeight: "700", color: Colors.textPrimary, marginBottom: 6 },
  emptyBody:      { fontSize: 13, color: Colors.textSecondary, textAlign: "center", lineHeight: 20 },
  emptyCode:      { fontWeight: "700", color: TEAL },
  linkBtn:        { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: TEAL, borderRadius: 26, paddingVertical: 13, paddingHorizontal: 26, marginTop: 18 },
  linkBtnTxt:     { color: Colors.white, fontSize: 14, fontWeight: "700" },
  emptySteps:     { alignSelf: "stretch", marginTop: 18, gap: 10 },
  stepRow:        { flexDirection: "row", alignItems: "center", gap: 10 },
  stepDot:        { width: 22, height: 22, borderRadius: 11, backgroundColor: TEAL, alignItems: "center", justifyContent: "center" },
  stepNum:        { fontSize: 11, fontWeight: "700", color: Colors.white },
  stepTxt:        { flex: 1, fontSize: 12, color: Colors.textSecondary },
});
