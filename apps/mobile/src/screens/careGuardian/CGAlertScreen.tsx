import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert as RNAlert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, FIRESTORE } from "@mediguard/shared";
import type { MissedDoseAlert } from "@mediguard/shared";
import { getDb } from "@mediguard/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
  doc,
  updateDoc,
} from "firebase/firestore";
import { useAuthStore } from "@/store/authStore";
import { callPatient, describeFirestoreError, fetchLinkedPatient, isCallable } from "@/utils/carePatient";
import type { LinkedPatient } from "@/utils/carePatient";

// ─── Constants ────────────────────────────────────────────────────────────────
const TEAL       = "#00695C";
const PAGE_LIMIT = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** ISO instant → "8:00 AM". */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
}

/** "Today" / "Yesterday" / "12 Aug" for the alert's date field. */
function formatDay(date: string): string {
  const today     = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
  if (date === today) return "Today";
  if (date === yesterday) return "Yesterday";
  const d = new Date(date);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function toAlert(id: string, data: Record<string, unknown>): MissedDoseAlert {
  return { id, ...(data as Omit<MissedDoseAlert, "id">) };
}

/** Newest first. Applied client-side so the unindexed fallback still sorts. */
function newestFirst(list: MissedDoseAlert[]): MissedDoseAlert[] {
  return [...list].sort((a, b) => (b.detectedAt ?? "").localeCompare(a.detectedAt ?? ""));
}

// ─── Alert row ────────────────────────────────────────────────────────────────

function AlertRow({
  item,
  fallbackPhone,
  onDismiss,
  dismissing,
}: {
  item: MissedDoseAlert;
  fallbackPhone?: string;
  onDismiss: (id: string) => void;
  dismissing: boolean;
}) {
  // The alert carries the phone denormalised; the linked patient's
  // emergencyContact is the fallback for alerts written before it was set.
  const phone   = item.patientPhone ?? fallbackPhone;
  const canCall = isCallable(phone);

  return (
    <View style={[s.card, item.acknowledged ? s.cardRead : s.cardUnread]}>
      <View style={s.cardTop}>
        <View style={s.iconCircle}>
          <Ionicons name="close-circle" size={22} color={Colors.alertRed} />
        </View>

        <View style={s.cardContent}>
          <Text style={s.cardLabel}>Missed Dose</Text>
          <Text style={s.cardMedicine} numberOfLines={1}>
            {item.medicineName}{item.dosage ? ` · ${item.dosage}` : ""}
          </Text>
          <Text style={s.cardMeta}>
            {formatDay(item.date)} at {formatTime(item.scheduledTime)} · missed {timeAgo(item.detectedAt)}
          </Text>
          <Text style={s.cardPatient} numberOfLines={1}>{item.patientName}</Text>
        </View>

        {!item.acknowledged && <View style={s.unreadDot} />}
      </View>

      <View style={s.actions}>
        <TouchableOpacity
          style={[s.actionBtn, s.callBtn, !canCall && s.btnOff]}
          onPress={() => callPatient(phone, item.patientName)}
          disabled={!canCall}
          activeOpacity={0.85}
        >
          <Ionicons name="call" size={15} color={Colors.white} />
          <Text style={s.callTxt}>Call Patient</Text>
        </TouchableOpacity>

        {item.acknowledged ? (
          <View style={[s.actionBtn, s.doneBtn]}>
            <Ionicons name="checkmark" size={15} color={Colors.textSecondary} />
            <Text style={s.doneTxt}>Dismissed</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[s.actionBtn, s.dismissBtn]}
            onPress={() => onDismiss(item.id)}
            disabled={dismissing}
            activeOpacity={0.8}
          >
            {dismissing ? (
              <ActivityIndicator size="small" color={TEAL} />
            ) : (
              <>
                <Ionicons name="checkmark-done-outline" size={15} color={TEAL} />
                <Text style={s.dismissTxt}>Dismiss</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      {!canCall && (
        <Text style={s.noPhone}>No phone number on file for {item.patientName}.</Text>
      )}
    </View>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ patientLinked, error }: { patientLinked: boolean; error: string | null }) {
  // An unreadable feed must never look like a clean bill of health.
  if (error) {
    return (
      <View style={s.emptyContainer}>
        <View style={s.emptyIconRed}>
          <Ionicons name="cloud-offline-outline" size={34} color={Colors.alertRed} />
        </View>
        <Text style={s.emptyTitle}>Alerts unavailable</Text>
        <Text style={s.emptySub}>{error}</Text>
      </View>
    );
  }
  if (!patientLinked) {
    return (
      <View style={s.emptyContainer}>
        <View style={s.emptyIcon}>
          <Ionicons name="person-add-outline" size={34} color={TEAL} />
        </View>
        <Text style={s.emptyTitle}>No patient linked</Text>
        <Text style={s.emptySub}>
          Ask your patient for their MG-XXXX code, then use Link Patient in the
          menu to start receiving missed-dose alerts.
        </Text>
      </View>
    );
  }
  return (
    <View style={s.emptyContainer}>
      <View style={s.emptyIconGreen}>
        <Ionicons name="shield-checkmark-outline" size={34} color={Colors.primary} />
      </View>
      <Text style={s.emptyTitle}>No missed doses</Text>
      <Text style={s.emptySub}>
        Every dose has been taken on time. If one is missed, it lands here
        5 minutes after it was due.
      </Text>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export function CGAlertScreen() {
  const user = useAuthStore((s) => s.user);

  const [alerts,     setAlerts]     = useState<MissedDoseAlert[]>([]);
  const [patient,    setPatient]    = useState<LinkedPatient | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [dismissing, setDismissing] = useState<string[]>([]);
  const [loadError,  setLoadError]  = useState<string | null>(null);

  const unreadCount = alerts.filter((a) => !a.acknowledged).length;

  // ── Realtime feed: missedDoseAlerts for THIS guardian ─────────────────────
  useEffect(() => {
    const uid = user?.id;
    if (!uid) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    // Patient lookup only powers the header + the phone fallback; the feed
    // below is keyed on guardianId, so it never waits on this.
    fetchLinkedPatient(uid)
      .then((p) => { if (!cancelled) setPatient(p); })
      .catch(() => {});

    // The ordered query needs the (guardianId, detectedAt desc) composite index.
    // While that index is still building Firestore answers failed-precondition,
    // which would strand this screen on an error for something that is only a
    // performance concern. So: try ordered, and on that one error fall back to a
    // plain equality query — which needs no composite index — and sort here.
    // Alert volume is a handful per patient, so the client-side sort is nothing.
    let active: (() => void) | null = null;

    const onData = (snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => {
      setAlerts(newestFirst(snap.docs.map((d) => toAlert(d.id, d.data()))));
      setLoadError(null);
      setLoading(false);
    };

    const subscribeUnordered = () => {
      active = onSnapshot(
        query(
          collection(getDb(), FIRESTORE.MISSED_DOSE_ALERTS),
          where("guardianId", "==", uid),
          limit(PAGE_LIMIT),
        ),
        onData,
        (err) => {
          console.warn("[CGAlertScreen] alerts listener error (unordered):", err);
          setAlerts([]);
          setLoadError(describeFirestoreError(err));
          setLoading(false);
        },
      );
    };

    active = onSnapshot(
      query(
        collection(getDb(), FIRESTORE.MISSED_DOSE_ALERTS),
        where("guardianId", "==", uid),
        orderBy("detectedAt", "desc"),
        limit(PAGE_LIMIT),
      ),
      onData,
      (err) => {
        if ((err as { code?: string })?.code === "failed-precondition") {
          console.warn("[CGAlertScreen] composite index missing — falling back to unordered read");
          active?.();
          subscribeUnordered();
          return;
        }
        // warn, not error: console.error trips LogBox's full-screen red box, and
        // this is a recoverable config problem the UI now explains in place.
        console.warn("[CGAlertScreen] alerts listener error:", err);
        setAlerts([]);
        setLoadError(describeFirestoreError(err));
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
      active?.();
    };
  }, [user?.id]);

  // ── Pull-to-refresh: re-resolve the patient + force a one-shot read ────────
  const onRefresh = useCallback(async () => {
    const uid = user?.id;
    if (!uid) return;
    setRefreshing(true);
    try {
      const base = collection(getDb(), FIRESTORE.MISSED_DOSE_ALERTS);
      const [linked, snap] = await Promise.all([
        fetchLinkedPatient(uid).catch(() => null),
        // Same index fallback as the listener — a refresh must not fail for a
        // reason the live feed already works around.
        getDocs(query(base, where("guardianId", "==", uid), orderBy("detectedAt", "desc"), limit(PAGE_LIMIT)))
          .catch((e) => {
            if ((e as { code?: string })?.code !== "failed-precondition") throw e;
            return getDocs(query(base, where("guardianId", "==", uid), limit(PAGE_LIMIT)));
          }),
      ]);
      setPatient(linked);
      setAlerts(newestFirst(snap.docs.map((d) => toAlert(d.id, d.data()))));
      setLoadError(null);
    } catch (err) {
      // Keep the in-place explanation in sync with the listener's, so a refresh
      // that fails for the same reason does not replace it with a vague toast.
      setLoadError(describeFirestoreError(err));
      RNAlert.alert("Could not refresh", describeFirestoreError(err));
    } finally {
      setRefreshing(false);
    }
  }, [user?.id]);

  // ── Acknowledge one alert ─────────────────────────────────────────────────
  const dismiss = useCallback(async (alertId: string) => {
    setDismissing((prev) => [...prev, alertId]);
    try {
      await updateDoc(doc(getDb(), FIRESTORE.MISSED_DOSE_ALERTS, alertId), {
        acknowledged:   true,
        acknowledgedAt: new Date().toISOString(),
      });
      // The snapshot listener pushes the new state back — no local mutation.
    } catch (err) {
      console.error("[CGAlertScreen] dismiss error:", err);
      RNAlert.alert("Error", "Could not dismiss this alert. Please try again.");
    } finally {
      setDismissing((prev) => prev.filter((id) => id !== alertId));
    }
  }, []);

  // ── Acknowledge everything unread ─────────────────────────────────────────
  const markAllRead = useCallback(async () => {
    const unread = alerts.filter((a) => !a.acknowledged);
    if (unread.length === 0) return;

    setMarkingAll(true);
    const acknowledgedAt = new Date().toISOString();
    try {
      const db = getDb();
      await Promise.all(
        unread.map((a) =>
          updateDoc(doc(db, FIRESTORE.MISSED_DOSE_ALERTS, a.id), { acknowledged: true, acknowledgedAt }),
        ),
      );
    } catch (err) {
      console.error("[CGAlertScreen] markAllRead error:", err);
      RNAlert.alert("Error", "Could not dismiss all alerts. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  }, [alerts]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.headerTitle}>Missed Doses</Text>
          <Text style={s.headerSub}>Monitoring: {patient?.name ?? "No patient linked"}</Text>
        </View>
        {unreadCount > 0 && (
          <TouchableOpacity
            style={s.markAllBtn}
            onPress={markAllRead}
            disabled={markingAll}
            activeOpacity={0.7}
          >
            {markingAll ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Text style={s.markAllText}>Dismiss All</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Unread badge bar */}
      {unreadCount > 0 && !loading && (
        <View style={s.badgeBar}>
          <View style={s.badge}>
            <Text style={s.badgeText}>
              {unreadCount} unread alert{unreadCount !== 1 ? "s" : ""}
            </Text>
          </View>
        </View>
      )}

      {/* Content */}
      {loading ? (
        <View style={s.loadingContainer}>
          <ActivityIndicator size="large" color={TEAL} />
          <Text style={s.loadingText}>Loading alerts…</Text>
        </View>
      ) : (
        <FlatList
          data={alerts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={alerts.length === 0 ? s.listEmpty : s.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={TEAL}
              colors={[TEAL]}
            />
          }
          ListEmptyComponent={<EmptyState patientLinked={patient !== null} error={loadError} />}
          renderItem={({ item }) => (
            <AlertRow
              item={item}
              fallbackPhone={patient?.phone}
              onDismiss={dismiss}
              dismissing={dismissing.includes(item.id)}
            />
          )}
          ItemSeparatorComponent={() => <View style={s.separator} />}
        />
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.bg,
  },

  // Header
  header: {
    backgroundColor: TEAL,
    paddingTop: 52,
    paddingBottom: 18,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: Colors.white,
  },
  headerSub: {
    fontSize: 12,
    color: "rgba(255,255,255,0.75)",
    marginTop: 2,
  },
  markAllBtn: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.7)",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    minWidth: 100,
    alignItems: "center",
    justifyContent: "center",
  },
  markAllText: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.white,
  },

  // Unread badge bar
  badgeBar: {
    backgroundColor: TEAL + "12",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: TEAL + "20",
  },
  badge: {
    alignSelf: "flex-start",
    backgroundColor: TEAL + "18",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: TEAL,
  },

  // List
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 32,
  },
  listEmpty: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  separator: {
    height: 10,
  },

  // Alert card
  card: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 14,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  cardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.alertRed,
  },
  cardRead: {
    opacity: 0.72,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.redPale,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardContent: {
    flex: 1,
    gap: 2,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.alertRed,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  cardMedicine: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  cardMeta: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  cardPatient: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: Colors.alertRed,
    flexShrink: 0,
  },

  // Row actions
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    paddingVertical: 11,
  },
  callBtn: {
    backgroundColor: TEAL,
  },
  callTxt: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.white,
  },
  dismissBtn: {
    backgroundColor: TEAL + "12",
    borderWidth: 1,
    borderColor: TEAL + "30",
  },
  dismissTxt: {
    fontSize: 13,
    fontWeight: "700",
    color: TEAL,
  },
  doneBtn: {
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  doneTxt: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  btnOff: {
    backgroundColor: "#B0BEC5",
  },
  noPhone: {
    fontSize: 11,
    color: Colors.textSecondary,
  },

  // Loading
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },

  // Empty state
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 32,
  },
  emptyIcon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: TEAL + "14",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyIconGreen: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: Colors.primaryPale,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyIconRed: {
    width: 68, height: 68, borderRadius: 34,
    alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.alertRed + "18",
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.textPrimary,
    textAlign: "center",
  },
  emptySub: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 19,
  },
});
