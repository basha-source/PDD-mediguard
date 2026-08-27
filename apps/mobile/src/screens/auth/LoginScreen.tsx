import { useState, useEffect, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
  Animated, Easing, Alert, Dimensions,
} from "react-native";
import { useNavigation }            from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";
import { doc, getDoc }              from "firebase/firestore";
import { GoogleAuthProvider, signInWithCredential } from "firebase/auth";
import * as Google                  from "expo-auth-session/providers/google";
import * as WebBrowser              from "expo-web-browser";
import { Ionicons }                 from "@expo/vector-icons";
import { signInWithEmail, signUpWithEmail, getFirebaseAuth, getDb } from "@mediguard/firebase";
import { registerForPushNotifications, saveFcmToken } from "@/services/notifications";
import { Colors, FIRESTORE }        from "@mediguard/shared";
import { ENV }                      from "@/config/env";
import type { AuthStackParams }     from "@/navigation/AuthStack";

WebBrowser.maybeCompleteAuthSession();

const { width: SW } = Dimensions.get("window");
const TAGLINE       = "Your trusted health companion";
const TEAL          = "#00897B"; // secondary accent for interactive elements
const CARD_BG       = "#F1F8F1"; // light green tint — white inputs pop against this

type Nav = StackNavigationProp<AuthStackParams, "Login">;

// ─── Medical logo (white circle + green cross — designed for green header) ───
function MedicalLogo({ pulse }: { pulse: Animated.Value }) {
  return (
    <Animated.View style={{ transform: [{ scale: pulse }] }}>
      <View style={il.circle}>
        <View style={il.hArm} />
        <View style={il.vArm} />
      </View>
    </Animated.View>
  );
}

const il = StyleSheet.create({
  circle: { width: 96, height: 96, borderRadius: 48, backgroundColor: "rgba(255,255,255,0.96)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 10 },
  hArm:   { position: "absolute", width: 52, height: 17, borderRadius: 9, backgroundColor: Colors.primary },
  vArm:   { position: "absolute", width: 17, height: 52, borderRadius: 9, backgroundColor: Colors.primary },
});

// ─── Floating label input ────────────────────────────────────────────────────
type FloatProps = {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: any;
  autoCapitalize?: any;
  autoCorrect?: boolean;
  rightElement?: React.ReactNode;
};

function FloatingLabelInput({ label, value, onChangeText, secureTextEntry, keyboardType, autoCapitalize, autoCorrect, rightElement }: FloatProps) {
  const inputRef = useRef<TextInput>(null);
  const anim   = useRef(new Animated.Value(value ? 1 : 0)).current;
  const [focused, setFocused] = useState(false);
  const isUp   = focused || value.length > 0;

  useEffect(() => {
    Animated.timing(anim, { toValue: isUp ? 1 : 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [isUp]); // eslint-disable-line react-hooks/exhaustive-deps

  const labelTop  = anim.interpolate({ inputRange: [0, 1], outputRange: [17, -9] });
  const labelSize = anim.interpolate({ inputRange: [0, 1], outputRange: [15, 11] });

  return (
    <View style={fl.wrap}>
      {/* TouchableWithoutFeedback routes taps in the paddingTop dead-zone to the TextInput */}
      <TouchableWithoutFeedback onPress={() => inputRef.current?.focus()}>
        <View style={[fl.box, focused && fl.boxFocused]}>
          <TextInput
            ref={inputRef}
            style={fl.input}
            value={value}
            onChangeText={onChangeText}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            secureTextEntry={secureTextEntry}
            keyboardType={keyboardType}
            autoCapitalize={autoCapitalize ?? "none"}
            autoCorrect={autoCorrect ?? false}
            placeholderTextColor="transparent"
          />
          {rightElement && <View style={fl.right}>{rightElement}</View>}
        </View>
      </TouchableWithoutFeedback>
      {/* Floating label — absolute overlay, pointerEvents none so it never blocks touches */}
      <Animated.View style={[fl.labelWrap, { top: labelTop }]} pointerEvents="none">
        <Animated.Text style={[fl.label, { fontSize: labelSize, color: isUp ? TEAL : Colors.textSecondary }]}>
          {label}
        </Animated.Text>
      </Animated.View>
    </View>
  );
}

const fl = StyleSheet.create({
  wrap:       { marginBottom: 22, position: "relative" },
  box:        { flexDirection: "row", alignItems: "center", backgroundColor: Colors.white, borderWidth: 1.5, borderColor: "#D0D5DD", borderRadius: 14, paddingHorizontal: 14, paddingTop: 22, paddingBottom: 10 },
  boxFocused: { borderColor: TEAL, shadowColor: TEAL, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 6, elevation: 2 },
  input:      { flex: 1, fontSize: 15, color: Colors.textPrimary, padding: 0 },
  right:      { paddingLeft: 8 },
  labelWrap:  { position: "absolute", left: 10, backgroundColor: Colors.white, paddingHorizontal: 4 },
  label:      { fontWeight: "500" },
});

// ─── Google sub-components ────────────────────────────────────────────────────
// GoogleButton mounts ONLY when correct platform client ID exists —
// Google.useAuthRequest throws on Android without androidClientId.
function GoogleButton({ onResult, disabled }: { onResult: (id: string | null, ac: string | null) => void; disabled: boolean }) {
  const [, response, promptAsync] = Google.useAuthRequest({
    webClientId:     ENV.GOOGLE_WEB_CLIENT_ID     || undefined,
    androidClientId: ENV.GOOGLE_ANDROID_CLIENT_ID || undefined,
  });
  useEffect(() => {
    if (response?.type !== "success") return;
    const idToken     = response.params?.id_token ?? response.authentication?.idToken ?? null;
    const accessToken = response.authentication?.accessToken ?? null;
    onResult(idToken, accessToken);
  }, [response]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <TouchableOpacity style={[s.gBtn, disabled && s.dimmed]} onPress={() => promptAsync()} disabled={disabled} activeOpacity={0.8}>
      <Text style={s.gBtnG}>G</Text>
      <Text style={s.gBtnTxt}>Continue with Google</Text>
    </TouchableOpacity>
  );
}

function GoogleButtonStub({ disabled }: { disabled: boolean }) {
  return (
    <TouchableOpacity style={[s.gBtn, disabled && s.dimmed]} onPress={() => Alert.alert("Coming Soon", "Google Sign-In will be available soon!")} disabled={disabled} activeOpacity={0.8}>
      <Text style={s.gBtnG}>G</Text>
      <Text style={s.gBtnTxt}>Continue with Google</Text>
    </TouchableOpacity>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────
export function LoginScreen() {
  const nav = useNavigation<Nav>();

  // ── auth state ──
  const [tab, setTab]           = useState<"signin" | "signup">("signin");
  const [email, setEmail]       = useState("");
  const [pass, setPass]         = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");
  const [showPass, setShowPass] = useState(false);

  // ── typing tagline ──
  const [tagline, setTagline] = useState("");
  const [cursor, setCursor]   = useState(false);

  // ── entrance animations ──
  const headerAnim = useRef(new Animated.Value(0)).current;
  const formAnim   = useRef(new Animated.Value(0)).current;

  // ── pulsing logo ──
  const pulse = useRef(new Animated.Value(1)).current;

  // ── button press: scale + ripple ──
  const btnScale      = useRef(new Animated.Value(1)).current;
  const rippleScale   = useRef(new Animated.Value(0)).current;
  const rippleOpacity = useRef(new Animated.Value(0)).current;

  // ── animated tab underline ──
  const tabAnim = useRef(new Animated.Value(0)).current;
  const TAB_W   = (SW - 48) / 2;

  useEffect(() => {
    // ── Entrance ──
    Animated.parallel([
      Animated.timing(headerAnim, { toValue: 1, duration: 550, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(220),
        Animated.timing(formAnim, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
    ]).start();

    // ── Pulse loop ──
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.08, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1,    duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();

    // ── Typing tagline ──
    let idx = 0;
    const startDelay = setTimeout(() => {
      setCursor(true);
      const typeInt = setInterval(() => {
        idx += 1;
        setTagline(TAGLINE.slice(0, idx));
        if (idx >= TAGLINE.length) {
          clearInterval(typeInt);
          let blinks = 0;
          const blinkInt = setInterval(() => {
            setCursor(v => !v);
            if (++blinks >= 6) { clearInterval(blinkInt); setCursor(false); }
          }, 380);
        }
      }, 48);
    }, 750);

    return () => clearTimeout(startDelay);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── tab switch with animated underline ──
  function switchTab(t: "signin" | "signup") {
    setTab(t);
    setError("");
    Animated.timing(tabAnim, { toValue: t === "signin" ? 0 : 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }

  // ── button press: scale + ripple ──
  function pressButton(action: () => void) {
    rippleScale.setValue(0);
    rippleOpacity.setValue(0.3);
    Animated.parallel([
      Animated.sequence([
        Animated.timing(btnScale, { toValue: 0.96, duration: 80,  useNativeDriver: true }),
        Animated.timing(btnScale, { toValue: 1,    duration: 100, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(rippleScale,   { toValue: 3.5, duration: 420, useNativeDriver: true }),
        Animated.timing(rippleOpacity, { toValue: 0,   duration: 420, useNativeDriver: true }),
      ]),
    ]).start();
    action();
  }

  // ── Google result ──
  function handleGoogleResult(idToken: string | null, accessToken: string | null) {
    if (!idToken && !accessToken) { setError("Google sign-in failed. Please try again."); return; }
    setLoading(true); setError("");
    const cred = GoogleAuthProvider.credential(idToken, accessToken ?? undefined);
    signInWithCredential(getFirebaseAuth(), cred)
      .then(async ({ user: fbUser }) => {
        const snap = await getDoc(doc(getDb(), FIRESTORE.USERS, fbUser.uid));
        if (!snap.exists()) nav.navigate("RoleSelection");
      })
      .catch(() => setError("Google sign-in failed. Please try again."))
      .finally(() => setLoading(false));
  }

  // ── email auth ──
  async function handleSignIn() {
    if (!email.trim() || !pass) { setError("Please fill in all fields"); return; }
    setLoading(true); setError("");
    try {
      const { user: fbUser } = await signInWithEmail(email.trim(), pass);
      registerForPushNotifications().then((token) => {
        if (token) saveFcmToken(fbUser.uid, token);
      }).catch(() => {});
      const snap = await getDoc(doc(getDb(), FIRESTORE.USERS, fbUser.uid));
      if (!snap.exists()) nav.navigate("RoleSelection");
    } catch (e: any) {
      const code = e?.code ?? "";
      // A wrong password is a normal outcome, not a crash. console.error trips
      // LogBox's full-screen red box in dev, which made a simple typo look like
      // an app failure — the message below already tells the user what to do.
      // Note Firebase folds "wrong password" AND "no such account" into
      // auth/invalid-credential when email-enumeration protection is on.
      const EXPECTED = [
        "auth/invalid-credential",
        "auth/user-not-found",
        "auth/wrong-password",
        "auth/invalid-email",
      ];
      if (EXPECTED.includes(code)) console.warn("[MediGuard] Sign-in rejected:", code);
      else console.error("[MediGuard] Sign-in error:", code, e?.message, e);
      setError(
        code === "auth/invalid-credential"     ? "Incorrect email or password" :
        code === "auth/user-not-found"         ? "No account with this email" :
        code === "auth/wrong-password"         ? "Incorrect password" :
        code === "auth/invalid-email"          ? "Invalid email address" :
        code === "auth/user-disabled"          ? "This account has been disabled" :
        code === "auth/too-many-requests"      ? "Too many attempts. Try again later" :
        code === "auth/network-request-failed" ? "Network error. Check your connection" :
        code === "auth/operation-not-allowed"  ? "Email sign-in is not enabled in Firebase" :
        `Error [${code || "unknown"}]: ${e?.message ?? "Sign in failed. Please try again."}`
      );
    } finally { setLoading(false); }
  }

  async function handleSignUp() {
    if (!email.trim() || !pass) { setError("Please fill in all fields"); return; }
    if (pass.length < 6) { setError("Password must be at least 6 characters"); return; }
    setLoading(true); setError("");
    try {
      const { user: fbUser } = await signUpWithEmail(email.trim(), pass);
      registerForPushNotifications().then((token) => {
        if (token) saveFcmToken(fbUser.uid, token);
      }).catch(() => {});
      nav.navigate("RoleSelection");
    } catch (e: any) {
      setError(
        e?.code === "auth/email-already-in-use" ? "An account with this email already exists" :
        e?.code === "auth/invalid-email"        ? "Invalid email address" :
        "Sign up failed. Please try again."
      );
    } finally { setLoading(false); }
  }

  const googleConfigured = Platform.OS === "android" ? !!ENV.GOOGLE_ANDROID_CLIENT_ID : !!ENV.GOOGLE_WEB_CLIENT_ID;

  const headerStyle = { opacity: headerAnim, transform: [{ translateY: headerAnim.interpolate({ inputRange: [0,1], outputRange: [-20, 0] }) }] };
  const cardStyle   = { opacity: formAnim,   transform: [{ translateY: formAnim.interpolate({ inputRange: [0,1], outputRange: [36, 0] }) }] };

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

        {/* ── Green header ── */}
        <Animated.View style={[s.header, headerStyle]}>
          {/* Decorative semi-transparent circles */}
          <View style={[s.decor, { width: 90,  height: 90,  top: -20, left: -20,       opacity: 0.07 }]} />
          <View style={[s.decor, { width: 55,  height: 55,  top: 30,  right: 20,       opacity: 0.09 }]} />
          <View style={[s.decor, { width: 35,  height: 35,  bottom: 30, left: "15%",   opacity: 0.1  }]} />
          <View style={[s.decor, { width: 22,  height: 22,  bottom: 10, right: "20%",  opacity: 0.12 }]} />

          <MedicalLogo pulse={pulse} />
          <Text style={s.brand}>MediGuard</Text>
          <Text style={s.taglineTxt}>
            {tagline}
            {cursor ? <Text style={s.cursor}>|</Text> : ""}
          </Text>
        </Animated.View>

        {/* ── Form card (light green tint) ── */}
        <Animated.View style={[s.card, cardStyle]}>

          {/* Tabs */}
          <View style={s.tabRow}>
            <TouchableOpacity style={s.tabItem} onPress={() => switchTab("signin")} activeOpacity={0.7}>
              <Text style={[s.tabTxt, tab === "signin" && s.tabActive]}>Sign In</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.tabItem} onPress={() => switchTab("signup")} activeOpacity={0.7}>
              <Text style={[s.tabTxt, tab === "signup" && s.tabActive]}>Sign Up</Text>
            </TouchableOpacity>
            {/* Sliding teal underline */}
            <Animated.View style={[s.tabUnderline, {
              transform: [{ translateX: tabAnim.interpolate({ inputRange: [0,1], outputRange: [0, TAB_W] }) }],
            }]} />
          </View>

          {/* Inputs */}
          <View style={{ marginTop: 28 }}>
            <FloatingLabelInput
              label="Email address"
              value={email}
              onChangeText={v => { setEmail(v); setError(""); }}
              keyboardType="email-address"
            />
            <FloatingLabelInput
              label="Password"
              value={pass}
              onChangeText={v => { setPass(v); setError(""); }}
              secureTextEntry={!showPass}
              rightElement={
                <TouchableOpacity onPress={() => setShowPass(v => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name={showPass ? "eye-off" : "eye"} size={20} color={Colors.textSecondary} />
                </TouchableOpacity>
              }
            />
          </View>

          {!!error && <Text style={s.error}>{error}</Text>}

          {/* Submit button — green with colored glow */}
          <Animated.View style={[s.btnWrap, { transform: [{ scale: btnScale }] }]}>
            <TouchableOpacity
              style={[s.btn, loading && s.dimmed]}
              onPress={() => pressButton(tab === "signin" ? handleSignIn : handleSignUp)}
              disabled={loading}
              activeOpacity={1}
            >
              {loading
                ? <ActivityIndicator color={Colors.white} />
                : <Text style={s.btnTxt}>{tab === "signin" ? "Sign In" : "Create Account"}</Text>
              }
              {/* Ripple overlay */}
              <Animated.View style={[s.ripple, { transform: [{ scale: rippleScale }], opacity: rippleOpacity }]} pointerEvents="none" />
            </TouchableOpacity>
          </Animated.View>

          {/* Forgot password — teal */}
          {tab === "signin" && (
            <TouchableOpacity style={{ alignSelf: "center", marginTop: 14 }} onPress={() => nav.navigate("ForgotPassword")}>
              <Text style={s.forgot}>Forgot Password?</Text>
            </TouchableOpacity>
          )}

          {/* Divider */}
          <View style={s.divider}>
            <View style={s.divLine} />
            <Text style={s.divTxt}>or</Text>
            <View style={s.divLine} />
          </View>

          {/* Google — grey fill, dark border */}
          {googleConfigured
            ? <GoogleButton     onResult={handleGoogleResult} disabled={loading} />
            : <GoogleButtonStub disabled={loading} />
          }
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.primary },

  // ── Header ──
  header: {
    backgroundColor:       Colors.primary,
    borderBottomLeftRadius:  36,
    borderBottomRightRadius: 36,
    paddingTop:    56,
    paddingBottom: 44,
    alignItems:    "center",
    overflow:      "hidden",
  },
  decor: {
    position:     "absolute",
    borderRadius: 999,
    backgroundColor: Colors.white,
  },
  brand: { fontSize: 28, fontWeight: "800", color: Colors.white, marginTop: 18, letterSpacing: 0.4 },
  taglineTxt: { fontSize: 13, color: Colors.primaryPale, marginTop: 6, letterSpacing: 0.2, height: 20 },
  cursor: { color: Colors.white, fontWeight: "200" },

  // ── Form card ──
  card: {
    backgroundColor:     CARD_BG,
    borderTopLeftRadius:  28,
    borderTopRightRadius: 28,
    marginTop:    -24,
    paddingHorizontal: 24,
    paddingTop:   32,
    paddingBottom: 48,
    flex: 1,
  },

  // ── Tabs ──
  tabRow:       { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#C8E6C9", position: "relative", marginBottom: 4 },
  tabItem:      { flex: 1, alignItems: "center", paddingVertical: 12 },
  tabTxt:       { fontSize: 15, fontWeight: "500", color: Colors.textSecondary },
  tabActive:    { color: TEAL, fontWeight: "700" },
  tabUnderline: { position: "absolute", bottom: -1, left: 0, width: (SW - 48) / 2, height: 2.5, backgroundColor: TEAL, borderRadius: 2 },

  // ── Error ──
  error: { color: Colors.alertRed, fontSize: 13, textAlign: "center", marginBottom: 8 },

  // ── Button ──
  btnWrap: {
    borderRadius:  14,
    overflow:     "hidden",
    // Colored glow (iOS only; Android gets elevation depth)
    shadowColor:   Colors.primary,
    shadowOffset:  { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius:  16,
    elevation:     8,
    marginTop:     4,
  },
  btn: {
    backgroundColor: Colors.primary,
    borderRadius:    14,
    paddingVertical: 16,
    alignItems:     "center",
    justifyContent: "center",
    overflow:        "hidden",
  },
  btnTxt:  { color: Colors.white, fontSize: 16, fontWeight: "700", letterSpacing: 0.3 },
  dimmed:  { opacity: 0.6 },
  ripple:  { position: "absolute", width: 80, height: 80, borderRadius: 40, backgroundColor: "rgba(255,255,255,0.35)", alignSelf: "center", top: -20 },

  // ── Forgot ──
  forgot: { color: TEAL, fontSize: 14, fontWeight: "500" },

  // ── Divider ──
  divider: { flexDirection: "row", alignItems: "center", marginVertical: 22 },
  divLine: { flex: 1, height: 1, backgroundColor: "#C8E6C9" },
  divTxt:  { marginHorizontal: 12, fontSize: 13, color: Colors.textSecondary, fontWeight: "500" },

  // ── Google button (grey fill, dark border) ──
  gBtn:    { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#F5F5F5", borderRadius: 14, borderWidth: 1.5, borderColor: "#9E9E9E", paddingVertical: 14 },
  gBtnG:   { fontSize: 18, fontWeight: "800", color: "#4285F4", marginRight: 10 },
  gBtnTxt: { fontSize: 15, fontWeight: "600", color: Colors.textPrimary },
});
