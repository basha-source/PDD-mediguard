import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { doc, updateDoc, collection, addDoc } from "firebase/firestore";
import { getDb } from "@mediguard/firebase";
import { FIRESTORE } from "@mediguard/shared";

const PROJECT_ID =
  (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ?? "";

// Android notification channels. On Android 8+ every notification MUST belong to
// a channel or it is silently dropped / shown without sound or heads-up.
const CHANNEL_DEFAULT = "default";
const CHANNEL_DOSE    = "dose-reminders";

// In Expo Go SDK 53+, importing expo-notifications itself crashes because the
// module calls addPushTokenListener during init. So we only require it outside
// Expo Go. In Expo Go all push helpers become no-ops; Firestore in-app
// notifications keep working.
const IS_EXPO_GO = Constants.executionEnvironment === "storeClient";

let Notifications: typeof import("expo-notifications") | null = null;
if (!IS_EXPO_GO) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Notifications = require("expo-notifications");
    // SDK 55: shouldShowAlert is deprecated — shouldShowBanner + shouldShowList
    // are what actually control whether a notification appears while the app is
    // in the FOREGROUND. Omitting them means in-app notifications never show.
    Notifications!.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList:   true,
        shouldPlaySound:  true,
        shouldSetBadge:   true,
      }),
    });
    // Register action categories so "Mark as Taken" button appears on dose alerts
    setupNotificationCategories().catch(() => {});
    // Create Android channels up front so scheduled/push notifications can surface.
    setupAndroidChannels().catch(() => {});
  } catch {
    Notifications = null;
  }
}

export async function setupAndroidChannels(): Promise<void> {
  if (!Notifications || Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_DEFAULT, {
      name:             "General",
      importance:       Notifications.AndroidImportance.HIGH,
      sound:            "default",
      vibrationPattern: [0, 250, 250, 250],
      lightColor:       "#2E7D32",
    });
    await Notifications.setNotificationChannelAsync(CHANNEL_DOSE, {
      name:             "Dose Reminders",
      importance:       Notifications.AndroidImportance.MAX,
      sound:            "default",
      vibrationPattern: [0, 250, 250, 250],
      lightColor:       "#2E7D32",
    });
  } catch { /* silently skip */ }
}

export async function setupNotificationCategories(): Promise<void> {
  if (!Notifications) return;
  try {
    await Notifications.setNotificationCategoryAsync("DOSE_ACTIONS", [
      {
        identifier: "MARK_TAKEN",
        buttonTitle: "✅ Mark as Taken",
        options: { opensAppToForeground: true },
      },
    ]);
  } catch { /* silently skip */ }
}

export async function registerForPushNotifications() {
  if (!Notifications) return null;
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== "granted") return null;
    const token = await Notifications.getExpoPushTokenAsync(PROJECT_ID ? { projectId: PROJECT_ID } : undefined);
    return token.data;
  } catch {
    return null;
  }
}

export async function scheduleDoseReminder(
  medicineName: string,
  scheduledTime: Date,
  medicineId?: string,
) {
  if (!Notifications) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "💊 Dose Reminder",
        body:  `Time to take ${medicineName}`,
        sound: true,
        data: {
          type:         "dose",
          screen:       "MissedDose",
          medicineId:   medicineId ?? "",
          medicineName,
        },
        categoryIdentifier: "DOSE_ACTIONS",
      },
      trigger: {
        type:      Notifications.SchedulableTriggerInputTypes.DAILY,
        hour:      scheduledTime.getHours(),
        minute:    scheduledTime.getMinutes(),
        channelId: CHANNEL_DOSE,
      },
    });
  } catch { /* silently skip */ }
}

export async function scheduleExpiryAlert(medicineName: string, daysLeft: number) {
  if (!Notifications) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "⚠️ Expiry Alert",
        body:  `${medicineName} expires in ${daysLeft} day${daysLeft > 1 ? "s" : ""}`,
        sound: true,
        data:  { type: "expiry", screen: "ExpiryAlerts" },
      },
      trigger: {
        type:      Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds:   60,
        channelId: CHANNEL_DEFAULT,
      },
    });
  } catch { /* silently skip */ }
}

export async function saveFcmToken(userId: string, token: string) {
  try {
    await updateDoc(doc(getDb(), FIRESTORE.USERS, userId), { fcmToken: token });
  } catch {
    // non-critical — silently fail
  }
}

export async function scheduleSnoozeReminder(medicineName: string, seconds = 1800) {
  if (!Notifications) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "💊 Dose Reminder",
        body:  `Take ${medicineName} now`,
        sound: true,
        data:  { type: "dose", screen: "MissedDose" },
        categoryIdentifier: "DOSE_ACTIONS",
      },
      trigger: {
        type:      Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds,
        channelId: CHANNEL_DOSE,
      },
    });
  } catch { /* silently skip */ }
}

export async function scheduleLowStockAlert(medicineName: string) {
  if (!Notifications) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "📦 Low Stock Alert",
        body:  `${medicineName} is running low. Time to reorder.`,
        sound: true,
        data:  { type: "refill", screen: "ExpiryAlerts" },
      },
      trigger: {
        type:      Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds:   5,
        channelId: CHANNEL_DEFAULT,
      },
    });
  } catch { /* silently skip */ }
}

export async function addInAppNotification(
  userId: string,
  title: string,
  body: string,
  type: "dose" | "expiry" | "refill" | "sos" | "careGuardian" | "wellness",
  data?: { screen?: string; medicineId?: string; medicineName?: string },
) {
  try {
    await addDoc(collection(getDb(), FIRESTORE.NOTIFICATIONS), {
      userId,
      title,
      body,
      type,
      read:      false,
      createdAt: new Date().toISOString(),
      ...(data ? { data } : {}),
    });
  } catch {
    // non-critical
  }
}

// ── Expiry alert deduplication ────────────────────────────────────────────────
// Stores { [medicineId]: "YYYY-MM-DD" } so we fire at most once per day per medicine.
const EXPIRY_NOTIF_KEY = "expiryNotifSent";

async function hasRecentExpiryNotif(medicineId: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(EXPIRY_NOTIF_KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    const today = new Date().toISOString().split("T")[0];
    return map[medicineId] === today;
  } catch { return false; }
}

async function markExpiryNotifSent(medicineId: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(EXPIRY_NOTIF_KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    map[medicineId] = new Date().toISOString().split("T")[0];
    await AsyncStorage.setItem(EXPIRY_NOTIF_KEY, JSON.stringify(map));
  } catch { /* silently skip */ }
}

export async function checkAndScheduleExpiryAlerts(
  medicines: Array<{ id: string; name: string; expiryDate?: string }>,
  userId: string,
) {
  const now = Date.now();
  for (const med of medicines) {
    if (!med.expiryDate) continue;
    const daysLeft = Math.floor((new Date(med.expiryDate).getTime() - now) / 86_400_000);
    if (daysLeft >= 0 && daysLeft <= 7) {
      if (await hasRecentExpiryNotif(med.id)) continue; // already sent today
      await scheduleExpiryAlert(med.name, daysLeft).catch(() => {});
      await addInAppNotification(
        userId,
        "⚠️ Expiry Alert",
        `${med.name} expires ${daysLeft === 0 ? "today" : `in ${daysLeft} day${daysLeft > 1 ? "s" : ""}`}`,
        "expiry",
        { screen: "ExpiryAlerts", medicineId: med.id, medicineName: med.name },
      ).catch(() => {});
      await markExpiryNotifSent(med.id);
    }
  }
}

// ── Daily Wellness Reminder ───────────────────────────────────────────────────
const WELLNESS_REMINDER_ID_KEY   = "wellnessReminderNotifId";
const WELLNESS_REMINDER_TIME_KEY = "wellnessReminderTime"; // stored as "HH:MM"

export async function scheduleDailyWellnessReminder(hour: number, minute: number): Promise<void> {
  if (!Notifications) return;
  try {
    await cancelDailyWellnessReminder();
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: "💚 Daily Wellness Check-In",
        body:  "How are you feeling today? Take a moment to log your wellness.",
        sound: true,
        data:  { type: "wellness", screen: "DailyLog" },
      },
      trigger: {
        type:      Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute,
        channelId: CHANNEL_DEFAULT,
      },
    });
    const hh = hour.toString().padStart(2, "0");
    const mm = minute.toString().padStart(2, "0");
    await AsyncStorage.setItem(WELLNESS_REMINDER_ID_KEY, id);
    await AsyncStorage.setItem(WELLNESS_REMINDER_TIME_KEY, `${hh}:${mm}`);
  } catch { /* silently skip */ }
}

export async function cancelDailyWellnessReminder(): Promise<void> {
  if (!Notifications) return;
  try {
    const id = await AsyncStorage.getItem(WELLNESS_REMINDER_ID_KEY);
    if (id) {
      await Notifications.cancelScheduledNotificationAsync(id);
    }
    await AsyncStorage.removeItem(WELLNESS_REMINDER_ID_KEY);
    await AsyncStorage.removeItem(WELLNESS_REMINDER_TIME_KEY);
  } catch { /* silently skip */ }
}

export async function getWellnessReminderTime(): Promise<{ hour: number; minute: number } | null> {
  try {
    const raw = await AsyncStorage.getItem(WELLNESS_REMINDER_TIME_KEY);
    if (!raw) return null;
    const [hStr, mStr] = raw.split(":");
    const hour   = parseInt(hStr, 10);
    const minute = parseInt(mStr, 10);
    if (
      Number.isNaN(hour) || Number.isNaN(minute) ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59
    ) {
      return null;
    }
    return { hour, minute };
  } catch {
    return null;
  }
}

// ── Push token + timezone persistence ─────────────────────────────────────────
// ADD-ONLY: registerForPushNotifications() fetches a token but never stored it,
// so the backend missed-dose cron had no address to push to. This writes the
// two fields it reads — users/{uid}.pushToken and users/{uid}.timezone.
//
// Safe when the token is null: in Expo Go the whole expo-notifications module is
// skipped (see IS_EXPO_GO above) and the register call returns null by design.
// The timezone is still written in that case, because the cron needs it to know
// when a wall-clock dose time actually fell due.
export async function savePushTokenForUser(userId: string): Promise<string | null> {
  if (!userId) return null;

  let token: string | null = null;
  try {
    token = await registerForPushNotifications();
  } catch {
    token = null;
  }

  let timezone = "";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch { /* Intl unavailable — skip the field */ }

  const patch: { pushToken?: string; timezone?: string } = {};
  if (token)    patch.pushToken = token;
  if (timezone) patch.timezone  = timezone;
  if (Object.keys(patch).length === 0) return null;

  try {
    await updateDoc(doc(getDb(), FIRESTORE.USERS, userId), patch);
  } catch {
    // non-critical — silently fail, exactly like saveFcmToken
  }
  return token;
}
