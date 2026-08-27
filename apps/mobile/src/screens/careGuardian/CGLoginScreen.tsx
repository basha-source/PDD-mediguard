import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@mediguard/shared";
import { signInWithEmail, getDb } from "@mediguard/firebase";
import { setDoc, doc, getDoc } from "firebase/firestore";
import { FIRESTORE, CARE_GUARDIAN } from "@mediguard/shared";
import { useAuthStore } from "@/store/authStore";

const TEAL = "#00695C";

export function CGLoginScreen() {
  const setUser = useAuthStore((s) => s.setUser);

  const [mode, setMode]             = useState<"link" | "login">("link");
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");
  const [patientCode, setPatientCode] = useState("");
  const [showPass, setShowPass]     = useState(false);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);

    // Validation
    if (!email.trim() || !password.trim()) {
      setError("Please fill all fields");
      return;
    }
    if (mode === "link" && !patientCode.trim()) {
      setError("Please fill all fields");
      return;
    }
    if (mode === "link" && !/^MG-[A-Z0-9]{4}$/i.test(patientCode.trim())) {
      setError("Patient code must be in the format MG-XXXX");
      return;
    }

    setLoading(true);
    try {
      // Step 1: Firebase Auth
      const credential = await signInWithEmail(email.trim(), password.trim());
      const uid = credential.user.uid;

      if (mode === "link") {
        const db = getDb();
        const code = patientCode.trim().toUpperCase();

        // Step 2: Look up the patient through the public code directory.
        // This used to be query(users, where careGuardianCode == code), which the
        // security rules always denied: listing /users requires uid == userId, and
        // a guardian is by definition a different user. Rules cannot authorise a
        // query at all, so the code must resolve by document ID instead.
        const codeSnap = await getDoc(doc(db, FIRESTORE.PATIENT_CODES, code));
        const patientId = codeSnap.exists() ? (codeSnap.data().patientId as string) : null;

        if (!patientId) {
          setError("Patient code not found. Ask your patient for their MG-XXXX code.");
          setLoading(false);
          return;
        }

        // Step 3: Create link document.
        // The doc ID is deterministic — CARE_GUARDIAN.linkId(guardianId, patientId)
        // — so the security rules can prove this link exists with a single
        // exists() lookup instead of a query (rules cannot run queries at all).
        // merge:true makes the write idempotent: re-linking the same
        // guardian/patient pair updates this one doc, never creates a duplicate.
        const linkRef = doc(
          db,
          FIRESTORE.CG_LINKS,
          CARE_GUARDIAN.linkId(uid, patientId)
        );
        await setDoc(
          linkRef,
          {
            patientId,
            guardianId: uid,
            code,
            linkedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      }

      // Step 4: Read guardian's own user doc and set in store
      const db = getDb();
      const userDocRef = doc(db, FIRESTORE.USERS, uid);
      const userSnap = await getDoc(userDocRef);

      if (userSnap.exists()) {
        setUser({ id: uid, ...(userSnap.data() as any) });
      }
      // RootNavigator will redirect to CareGuardianDrawer because role === "careGuardian"
    } catch (err: any) {
      const code: string = err?.code ?? "";
      if (
        code === "auth/wrong-password" ||
        code === "auth/user-not-found" ||
        code === "auth/invalid-credential"
      ) {
        setError("Invalid email or password");
      } else if (code === "auth/network-request-failed") {
        setError("Connection error. Check your internet.");
      } else if (code === "auth/invalid-email") {
        setError("Invalid email or password");
      } else {
        setError("Connection error. Check your internet.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        style={s.root}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={s.header}>
          <View style={s.iconWrap}>
            <Ionicons name="people" size={40} color={Colors.white} />
          </View>
          <Text style={s.headerTitle}>Care Guardian</Text>
          <Text style={s.headerSub}>Monitor Your Loved Ones</Text>
        </View>

        {/* Form Card */}
        <View style={s.formCard}>
          <Text style={s.formHeading}>
            {mode === "link" ? "Login & Link Patient" : "Care Guardian Login"}
          </Text>

          {/* Email */}
          <View style={s.inputRow}>
            <Ionicons name="mail-outline" size={20} color={TEAL} style={s.inputIcon} />
            <TextInput
              style={s.input}
              placeholder="Email address"
              placeholderTextColor={Colors.textSecondary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
            />
          </View>

          {/* Password */}
          <View style={s.inputRow}>
            <Ionicons name="lock-closed-outline" size={20} color={TEAL} style={s.inputIcon} />
            <TextInput
              style={[s.input, s.inputFlex]}
              placeholder="Password"
              placeholderTextColor={Colors.textSecondary}
              secureTextEntry={!showPass}
              value={password}
              onChangeText={setPassword}
            />
            <TouchableOpacity onPress={() => setShowPass((v) => !v)} style={s.eyeBtn}>
              <Ionicons
                name={showPass ? "eye-off-outline" : "eye-outline"}
                size={20}
                color={Colors.textSecondary}
              />
            </TouchableOpacity>
          </View>

          {/* Patient Code — only in "link" mode */}
          {mode === "link" && (
            <View style={s.inputRow}>
              <Ionicons name="qr-code-outline" size={20} color={TEAL} style={s.inputIcon} />
              <TextInput
                style={s.input}
                placeholder="Patient Code (MG-XXXX)"
                placeholderTextColor={Colors.textSecondary}
                autoCapitalize="characters"
                autoCorrect={false}
                value={patientCode}
                onChangeText={setPatientCode}
                maxLength={7}
              />
            </View>
          )}

          {/* Error card */}
          {error && (
            <View style={s.errorCard}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.alertRed} />
              <Text style={s.errorTxt}>{error}</Text>
            </View>
          )}

          {/* Submit button */}
          <TouchableOpacity
            style={[s.btn, loading && s.btnDisabled]}
            onPress={handleSubmit}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={s.btnTxt}>
                {mode === "link" ? "LOGIN & LINK PATIENT" : "LOGIN"}
              </Text>
            )}
          </TouchableOpacity>

          {/* Mode toggle */}
          <TouchableOpacity
            style={s.toggleWrap}
            onPress={() => {
              setMode((m) => (m === "link" ? "login" : "link"));
              setError(null);
            }}
          >
            <Text style={s.toggleTxt}>
              {mode === "link"
                ? "Already linked? Login"
                : "New here? Link a Patient"}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex:         { flex: 1 },
  root:         { flex: 1, backgroundColor: Colors.bg },
  content:      { flexGrow: 1, paddingBottom: 48 },

  // Header
  header:       {
    backgroundColor: TEAL,
    paddingTop: 52,
    paddingBottom: 36,
    alignItems: "center",
  },
  iconWrap:     {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  headerTitle:  { fontSize: 24, fontWeight: "800", color: Colors.white, marginBottom: 4 },
  headerSub:    { fontSize: 14, color: "rgba(255,255,255,0.8)" },

  // Form
  formCard:     {
    backgroundColor: Colors.card,
    margin: 20,
    borderRadius: 20,
    padding: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 4,
  },
  formHeading:  {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.textPrimary,
    marginBottom: 20,
    textAlign: "center",
  },

  // Inputs
  inputRow:     {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.bg,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    minHeight: 52,
  },
  inputIcon:    { marginRight: 10 },
  input:        { flex: 1, fontSize: 15, color: Colors.textPrimary, paddingVertical: 14 },
  inputFlex:    { flex: 1 },
  eyeBtn:       { padding: 4 },

  // Error
  errorCard:    {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFF2F2",
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#FFCDD2",
  },
  errorTxt:     { flex: 1, fontSize: 13, color: Colors.alertRed, lineHeight: 18 },

  // Button
  btn:          {
    backgroundColor: TEAL,
    borderRadius: 30,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 4,
  },
  btnDisabled:  { opacity: 0.55 },
  btnTxt:       { fontSize: 15, fontWeight: "700", color: Colors.white, letterSpacing: 0.5 },

  // Toggle
  toggleWrap:   { marginTop: 18, alignItems: "center" },
  toggleTxt:    { fontSize: 13, color: Colors.textSecondary, textDecorationLine: "underline" },
});
