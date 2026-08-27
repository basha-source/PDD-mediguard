import { useEffect, useRef, useState } from "react";
import { createStackNavigator }  from "@react-navigation/stack";
import { useNavigation }          from "@react-navigation/native";
import {
  View, Text, TouchableOpacity, TouchableWithoutFeedback,
  StyleSheet, Alert, Animated, Easing, Dimensions,
} from "react-native";
import { useSafeAreaInsets }  from "react-native-safe-area-context";
import { Ionicons }           from "@expo/vector-icons";
import { Colors }             from "@mediguard/shared";
import { useAuthStore }       from "@/store/authStore";
import { signOutUser }        from "@mediguard/firebase";
import { DrawerContext }      from "./drawerContext";
import { savePushTokenForUser } from "@/services/notifications";

import { CareGuardianTabs }       from "./CareGuardianTabs";
import { CGPatientMonitorScreen } from "@/screens/careGuardian/CGPatientMonitorScreen";
import { CGLinkPatientScreen } from "@/screens/careGuardian/CGLinkPatientScreen";
import { CGAlertScreen }          from "@/screens/careGuardian/CGAlertScreen";

export type CGStackParams = {
  Main:           undefined;
  LinkPatient:    undefined;
  PatientMonitor: undefined;
  Alerts:         undefined;
};

const Stack    = createStackNavigator<CGStackParams>();
const DRAWER_W = Math.min(300, Dimensions.get("window").width * 0.82);
const TEAL     = "#00695C";

// ─── Drawer panel content ─────────────────────────────────────────────────────
function CGSideDrawer({ onClose }: { onClose: () => void }) {
  const insets   = useSafeAreaInsets();
  const nav      = useNavigation<any>();
  const { user } = useAuthStore();
  const initials = (user?.name ?? user?.email ?? "CG").slice(0, 2).toUpperCase();

  function goTo(screen: keyof CGStackParams) {
    onClose();
    setTimeout(() => nav.navigate(screen as any), 200);
  }

  function handleLogout() {
    onClose();
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: signOutUser },
    ]);
  }

  return (
    <View style={[d.root, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 12) }]}>
      {/* ── User header ── */}
      <View style={d.header}>
        <View style={d.avatar}><Text style={d.avatarTxt}>{initials}</Text></View>
        <Text style={d.name} numberOfLines={1}>{user?.name ?? "Care Guardian"}</Text>
        <Text style={d.email} numberOfLines={1}>{user?.email ?? ""}</Text>
        <View style={d.badge}><Text style={d.badgeTxt}>Care Guardian</Text></View>
      </View>

      <View style={{ flex: 1, paddingTop: 8 }}>
        {/* ── Dashboard shortcut ── */}
        <TouchableOpacity
          style={d.homeBtn}
          onPress={() => { onClose(); nav.navigate("Main" as any); }}
          activeOpacity={0.8}
        >
          <Ionicons name="grid-outline" size={17} color={Colors.white} />
          <Text style={d.homeBtnTxt}>Dashboard</Text>
        </TouchableOpacity>

        <Text style={d.sectionTitle}>Monitoring</Text>

        <TouchableOpacity style={d.item} onPress={() => goTo("LinkPatient")} activeOpacity={0.7}>
          <Ionicons name="person-add-outline" size={17} color="#78909C" style={{ width: 24 }} />
          <Text style={d.itemTxt}>Link Patient</Text>
        </TouchableOpacity>

        <TouchableOpacity style={d.item} onPress={() => goTo("PatientMonitor")} activeOpacity={0.7}>
          <Ionicons name="pulse-outline" size={17} color="#78909C" style={{ width: 24 }} />
          <Text style={d.itemTxt}>Patient Monitor</Text>
        </TouchableOpacity>

        <TouchableOpacity style={d.item} onPress={() => goTo("Alerts")} activeOpacity={0.7}>
          <Ionicons name="notifications-outline" size={17} color="#78909C" style={{ width: 24 }} />
          <Text style={d.itemTxt}>Alerts</Text>
        </TouchableOpacity>
      </View>

      {/* ── Sign out ── */}
      <TouchableOpacity style={d.logout} onPress={handleLogout} activeOpacity={0.8}>
        <Ionicons name="log-out-outline" size={17} color={Colors.alertRed} />
        <Text style={d.logoutTxt}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}

const d = StyleSheet.create({
  root:      { flex: 1, backgroundColor: Colors.white },
  header:    { backgroundColor: TEAL, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24 },
  avatar:    { width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(255,255,255,0.22)", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  avatarTxt: { fontSize: 22, fontWeight: "700", color: Colors.white },
  name:      { fontSize: 16, fontWeight: "700", color: Colors.white, marginBottom: 2 },
  email:     { fontSize: 12, color: "rgba(255,255,255,0.75)" },
  badge:     { marginTop: 10, alignSelf: "flex-start", backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  badgeTxt:  { fontSize: 11, color: Colors.white, fontWeight: "600" },
  homeBtn:   { flexDirection: "row", alignItems: "center", backgroundColor: TEAL, marginHorizontal: 14, marginTop: 14, marginBottom: 6, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14, gap: 8 },
  homeBtnTxt:{ fontSize: 14, fontWeight: "700", color: Colors.white },
  sectionTitle: { fontSize: 10, fontWeight: "700", color: "#90A4AE", letterSpacing: 0.8, textTransform: "uppercase", marginTop: 18, marginBottom: 4, marginHorizontal: 20 },
  item:      { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 16, marginHorizontal: 8, borderRadius: 10, gap: 10 },
  itemTxt:   { fontSize: 14, color: "#546E7A", fontWeight: "500" },
  logout:    { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: 1, borderTopColor: "#ECEFF1", gap: 10 },
  logoutTxt: { fontSize: 14, color: Colors.alertRed, fontWeight: "600" },
});

// ─── Tab screen with animated drawer overlay ─────────────────────────────────
function CGTabsWithDrawer() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const slideAnim   = useRef(new Animated.Value(-DRAWER_W)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;

  function openDrawer() {
    setDrawerOpen(true);
    Animated.parallel([
      Animated.timing(slideAnim,   { toValue: 0, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(overlayAnim, { toValue: 1, duration: 280, useNativeDriver: true }),
    ]).start();
  }

  function closeDrawer() {
    Animated.parallel([
      Animated.timing(slideAnim,   { toValue: -DRAWER_W, duration: 240, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.timing(overlayAnim, { toValue: 0,         duration: 240, useNativeDriver: true }),
    ]).start(() => setDrawerOpen(false));
  }

  return (
    <DrawerContext.Provider value={{ openDrawer, closeDrawer }}>
      <View style={{ flex: 1 }}>
        <CareGuardianTabs />

        {drawerOpen && (
          <>
            <TouchableWithoutFeedback onPress={closeDrawer}>
              <Animated.View
                style={[
                  StyleSheet.absoluteFillObject,
                  { backgroundColor: "rgba(0,0,0,0.45)", opacity: overlayAnim },
                ]}
              />
            </TouchableWithoutFeedback>

            <Animated.View style={[p.panel, { transform: [{ translateX: slideAnim }] }]}>
              <CGSideDrawer onClose={closeDrawer} />
            </Animated.View>
          </>
        )}
      </View>
    </DrawerContext.Provider>
  );
}

const p = StyleSheet.create({
  panel: {
    position:      "absolute",
    left: 0, top: 0, bottom: 0,
    width:         DRAWER_W,
    shadowColor:   "#000",
    shadowOffset:  { width: 4, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius:  12,
    elevation:     16,
  },
});

// ─── Stack navigator (exported as CareGuardianDrawer to match RootNavigator) ──
export function CareGuardianDrawer() {
  const guardianId = useAuthStore((s) => s.user?.id);

  // This navigator only mounts once RootNavigator has an authenticated user with
  // role === "careGuardian", so it is the single narrowest place that covers both
  // a fresh CG login and a restored session — no login screen needs touching.
  useEffect(() => {
    if (!guardianId) return;
    savePushTokenForUser(guardianId).catch(() => {});
  }, [guardianId]);

  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: "default" }}>
      <Stack.Screen name="Main"          component={CGTabsWithDrawer} />
      <Stack.Screen name="LinkPatient"   component={CGLinkPatientScreen} />
      <Stack.Screen name="PatientMonitor" component={CGPatientMonitorScreen} />
      <Stack.Screen name="Alerts"        component={CGAlertScreen} />
    </Stack.Navigator>
  );
}
