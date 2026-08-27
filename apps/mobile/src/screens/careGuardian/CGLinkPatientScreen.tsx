import { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { getDb } from "@mediguard/firebase";
import { Colors, FIRESTORE, CARE_GUARDIAN } from "@mediguard/shared";
import { useAuthStore } from "@/store/authStore";

const TEAL = "#00695C";

/**
 * Link a patient to the guardian who is ALREADY signed in.
 *
 * CGLoginScreen also links, but only as part of a full email+password sign-in —
 * useless once the guardian is inside the app, and it was never mounted in any
 * navigator, so linking had no reachable UI at all.
 */
export function CGLinkPatientScreen() {
  const nav  = useNavigation<any>();
  const user = useAuthStore((s) => s.user);

  const [code,    setCode]    = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [linked,  setLinked]  = useState<string | null>(null);

  async function handleLink() {
    const value = code.trim().toUpperCase();
    setError(null);

    if (!/^MG-[A-Z0-9]{4}$/.test(value)) {
      setError("Codes look like MG-4K2P. Check the code and try again.");
      return;
    }
    const uid = user?.id;
    if (!uid) { setError("You are not signed in."); return; }

    setLoading(true);
    try {
      const db = getDb();

      // Resolve the code through the public directory. Rules cannot authorise a
      // query, so the code IS the document id.
      const codeSnap  = await getDoc(doc(db, FIRESTORE.PATIENT_CODES, value));
      const patientId = codeSnap.exists() ? (codeSnap.data().patientId as string) : null;

      if (!patientId) {
        setError("No patient found with that code. Ask them to open MediGuard → Profile and read it out again.");
        return;
      }
      if (patientId === uid) {
        setError("That is your own code — enter the code of the patient you want to monitor.");
        return;
      }

      // Write the link FIRST. The rule that lets a guardian read the patient's
      // profile is isGuardianOf(), which checks that this very link document
      // exists — so reading the patient's name before creating it is denied.
      await setDoc(
        doc(db, FIRESTORE.CG_LINKS, CARE_GUARDIAN.linkId(uid, patientId)),
        { patientId, guardianId: uid, code: value, linkedAt: new Date().toISOString() },
        { merge: true },
      );

      // The link is written — from here the patient IS linked. Their name is a
      // nicety, and reading it needs the isGuardianOf() rule, which an older
      // Console ruleset does not have. Letting that throw here reported a
      // failure for a link that had actually succeeded, so it stays best-effort.
      let name = "your patient";
      try {
        const patientSnap = await getDoc(doc(db, FIRESTORE.USERS, patientId));
        name = (patientSnap.data()?.name as string) ?? name;
      } catch { /* profile unreadable — the link still stands */ }
      setLinked(name);
    } catch (e: any) {
      const c = e?.code ?? "";
      setError(
        c === "permission-denied"
          ? "Not allowed to link yet — the MediGuard security rules still need to be published in the Firebase Console."
          : c === "unavailable"
          ? "Can't reach the server. Check your internet connection."
          : "Could not link that patient. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  if (linked) {
    return (
      <View style={s.root}>
        <View style={s.header}>
          <View style={{ width: 24 }} />
          <Text style={s.headerTitle}>Patient Linked</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={s.doneWrap}>
          <Ionicons name="checkmark-circle" size={56} color={Colors.primary} style={s.doneIcon} />
          <Text style={s.doneTitle}>You are monitoring {linked}</Text>
          <Text style={s.doneBody}>
            If a dose is not taken within 5 minutes of its scheduled time you will
            be alerted here, and can call {linked} straight from the alert.
          </Text>
          <TouchableOpacity style={s.primaryBtn} onPress={() => nav.navigate("Main")} activeOpacity={0.85}>
            <Text style={s.primaryTxt}>Go to Dashboard</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="arrow-back" size={24} color={Colors.white} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Link a Patient</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <View style={s.cardIcon}>
            <Ionicons name="qr-code-outline" size={30} color={TEAL} />
          </View>
          <Text style={s.cardTitle}>Enter their MediGuard code</Text>
          <Text style={s.cardBody}>
            Ask your patient to open MediGuard {"→"} Profile. Their code is shown
            there and looks like <Text style={s.mono}>MG-4K2P</Text>.
          </Text>

          <TextInput
            style={s.input}
            placeholder="MG-XXXX"
            placeholderTextColor={Colors.textSecondary}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={7}
            value={code}
            onChangeText={(v) => { setCode(v); if (error) setError(null); }}
            onSubmitEditing={handleLink}
            returnKeyType="done"
          />

          {!!error && (
            <View style={s.errorCard}>
              <Ionicons name="alert-circle-outline" size={16} color={Colors.alertRed} />
              <Text style={s.errorTxt}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[s.primaryBtn, loading && s.btnDisabled]}
            onPress={handleLink}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color={Colors.white} />
              : <Text style={s.primaryTxt}>Link Patient</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex:        { flex: 1, backgroundColor: Colors.bg },
  root:        { flex: 1, backgroundColor: Colors.bg },
  content:     { padding: 20 },
  header:      { backgroundColor: TEAL, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 48, paddingBottom: 18 },
  headerTitle: { color: Colors.white, fontSize: 18, fontWeight: "bold" },
  card:        { backgroundColor: Colors.card, borderRadius: 16, padding: 22, alignItems: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  cardIcon:    { width: 62, height: 62, borderRadius: 31, backgroundColor: TEAL + "18", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  cardTitle:   { fontSize: 17, fontWeight: "700", color: Colors.textPrimary, marginBottom: 6 },
  cardBody:    { fontSize: 13, color: Colors.textSecondary, textAlign: "center", lineHeight: 19, marginBottom: 18 },
  mono:        { fontWeight: "700", color: TEAL },
  input:       { width: "100%", backgroundColor: Colors.bg, borderRadius: 12, borderWidth: 1, borderColor: Colors.primaryPale, paddingVertical: 14, fontSize: 20, fontWeight: "700", letterSpacing: 3, textAlign: "center", color: Colors.textPrimary },
  errorCard:   { flexDirection: "row", alignItems: "flex-start", gap: 6, backgroundColor: Colors.alertRed + "12", borderRadius: 10, padding: 10, marginTop: 12 },
  errorTxt:    { flex: 1, color: Colors.alertRed, fontSize: 12, lineHeight: 17 },
  primaryBtn:  { backgroundColor: TEAL, borderRadius: 28, paddingVertical: 15, alignItems: "center", marginTop: 18, width: "100%" },
  btnDisabled: { opacity: 0.6 },
  primaryTxt:  { color: Colors.white, fontSize: 15, fontWeight: "700" },
  doneWrap:    { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  doneIcon:    { marginBottom: 16 },
  doneTitle:   { fontSize: 19, fontWeight: "700", color: Colors.textPrimary, textAlign: "center", marginBottom: 8 },
  doneBody:    { fontSize: 13, color: Colors.textSecondary, textAlign: "center", lineHeight: 20 },
});
