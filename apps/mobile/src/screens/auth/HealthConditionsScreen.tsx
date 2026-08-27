import { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { StackNavigationProp, RouteProp } from "@react-navigation/stack";
import { doc, setDoc }            from "firebase/firestore";
import { getFirebaseAuth, getDb } from "@mediguard/firebase";
import { Colors, FIRESTORE }      from "@mediguard/shared";
import type { User }              from "@mediguard/shared";
import { useAuthStore }           from "@/store/authStore";
import type { AuthStackParams }   from "@/navigation/AuthStack";

type Nav   = StackNavigationProp<AuthStackParams, "HealthConditions">;
type Route = RouteProp<AuthStackParams, "HealthConditions">;

const BLOOD_GROUPS       = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const NO_CONDITIONS      = "Normal";
const NO_ALLERGIES       = "None";
const COMMON_CONDITIONS  = ["Normal", "Diabetes", "Hypertension", "Asthma", "Heart Disease", "Thyroid"];
const COMMON_ALLERGIES   = ["None", "Penicillin", "Aspirin", "Ibuprofen", "Sulfa drugs", "Codeine"];
const INIT_CONDITIONS: string[] = [];
const INIT_ALLERGIES:  string[] = [];

// "Other" is a UI affordance only — the literal string is never stored
type Section = {
  list:    string[]; setList:  (v: string[]) => void;
  presets: string[]; sentinel: string;
  open:    boolean;  setOpen:  (v: boolean) => void;
  input:   string;   setInput: (v: string) => void;
};

const customOf = (list: string[], presets: string[]) => list.filter(i => !presets.includes(i));

export function HealthConditionsScreen() {
  const nav            = useNavigation<Nav>();
  const route          = useRoute<Route>();
  const { role }       = route.params;
  const setUser        = useAuthStore((s) => s.setUser);

  const [name, setName]           = useState("");
  const [bloodGroup, setBloodGroup] = useState("");
  const [conditions, setConditions] = useState<string[]>(INIT_CONDITIONS);
  const [allergies, setAllergies]   = useState<string[]>(INIT_ALLERGIES);
  const [emergency, setEmergency]   = useState("");
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState("");

  const [condOther, setCondOther] = useState(() => customOf(INIT_CONDITIONS, COMMON_CONDITIONS).length > 0);
  const [condInput, setCondInput] = useState("");
  const [allgOther, setAllgOther] = useState(() => customOf(INIT_ALLERGIES, COMMON_ALLERGIES).length > 0);
  const [allgInput, setAllgInput] = useState("");

  const condSec: Section = {
    list: conditions, setList: setConditions, presets: COMMON_CONDITIONS, sentinel: NO_CONDITIONS,
    open: condOther,  setOpen: setCondOther,  input:   condInput,         setInput: setCondInput,
  };
  const allgSec: Section = {
    list: allergies,  setList: setAllergies,  presets: COMMON_ALLERGIES,  sentinel: NO_ALLERGIES,
    open: allgOther,  setOpen: setAllgOther,  input:   allgInput,         setInput: setAllgInput,
  };

  // sentinel ("Normal"/"None") is exclusive: picking it clears the rest, picking anything else drops it
  function toggleWithSentinel(list: string[], setList: (v: string[]) => void, item: string, sentinel: string) {
    if (item === sentinel) { setList(list.includes(item) ? [] : [sentinel]); return; }
    const next = list.includes(item) ? list.filter(i => i !== item) : [...list, item];
    setList(next.filter(i => i !== sentinel));
  }

  // preset chip tap — selecting the sentinel also collapses + clears the "Other" field
  function toggleChip(sec: Section, item: string) {
    toggleWithSentinel(sec.list, sec.setList, item, sec.sentinel);
    if (item === sec.sentinel && !sec.list.includes(item)) { sec.setOpen(false); sec.setInput(""); }
  }

  function toggleOther(sec: Section) {
    if (!sec.open) { sec.setOpen(true); sec.setList(sec.list.filter(i => i !== sec.sentinel)); return; }
    if (customOf(sec.list, sec.presets).length) return;   // cannot close while custom pills exist
    sec.setOpen(false); sec.setInput("");
  }

  function addCustom(sec: Section) {
    const v = sec.input.trim();
    if (!v) return;
    const lc = v.toLowerCase();
    sec.setInput("");
    if (lc === sec.sentinel.toLowerCase()) { sec.setList([sec.sentinel]); sec.setOpen(false); return; }
    const preset = sec.presets.find(p => p.toLowerCase() === lc);
    if (preset) { if (!sec.list.includes(preset)) toggleWithSentinel(sec.list, sec.setList, preset, sec.sentinel); return; }
    if (sec.list.some(i => i.toLowerCase() === lc)) return;
    sec.setList([...sec.list.filter(i => i !== sec.sentinel), v]);
  }

  const removeCustom = (sec: Section, v: string) => sec.setList(sec.list.filter(i => i !== v));

  function renderOther(sec: Section) {
    if (!sec.open) return null;
    const custom = customOf(sec.list, sec.presets);
    return (
      <>
        <View style={s.otherRow}>
          <TextInput
            style={[s.input, s.otherInput]}
            placeholder="Type and tap +"
            placeholderTextColor={Colors.textSecondary}
            value={sec.input}
            onChangeText={sec.setInput}
            onSubmitEditing={() => addCustom(sec)}
            returnKeyType="done"
            autoCapitalize="sentences"
          />
          <TouchableOpacity style={s.otherAdd} onPress={() => addCustom(sec)}>
            <Ionicons name="add" size={20} color={Colors.white} />
          </TouchableOpacity>
        </View>
        {!!custom.length && (
          <View style={s.pillRow}>
            {custom.map(v => (
              <View key={v} style={s.pill}>
                <Text style={s.pillTxt}>{v}</Text>
                <TouchableOpacity onPress={() => removeCustom(sec, v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close" size={14} color={Colors.white} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      </>
    );
  }

  async function handleComplete() {
    if (!name.trim()) { setError("Please enter your full name"); return; }
    setLoading(true);
    setError("");
    try {
      const fbUser = getFirebaseAuth().currentUser;
      if (!fbUser) throw new Error("Not authenticated");

      const profile: Omit<User, "id"> = {
        name:             name.trim(),
        email:            fbUser.email ?? "",
        role,
        bloodGroup:       bloodGroup || undefined,
        conditions:       conditions.length ? conditions : undefined,
        allergies:        allergies.length ? allergies : undefined,
        emergencyContact: emergency.trim() || undefined,
        createdAt:        new Date().toISOString(),
      };

      await setDoc(doc(getDb(), FIRESTORE.USERS, fbUser.uid), profile);
      setUser({ id: fbUser.uid, ...profile });
      // RootNavigator detects user in store → switches to PatientTabs / CareGuardianTabs
    } catch {
      setError("Failed to save profile. Please try again.");
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={s.header}>
          <Text style={s.title}>Your Health Profile</Text>
          <Text style={s.sub}>Helps us personalise your experience</Text>
        </View>

        <Text style={s.label}>Full Name *</Text>
        <TextInput
          style={s.input}
          placeholder="Enter your full name"
          placeholderTextColor={Colors.textSecondary}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
        />

        <Text style={s.label}>Blood Group</Text>
        <View style={s.chipRow}>
          {BLOOD_GROUPS.map(bg => (
            <TouchableOpacity
              key={bg}
              style={[s.chip, bloodGroup === bg && s.chipActive]}
              onPress={() => setBloodGroup(bloodGroup === bg ? "" : bg)}
            >
              <Text style={[s.chipTxt, bloodGroup === bg && s.chipTxtActive]}>{bg}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={s.label}>Medical Conditions</Text>
        <View style={s.chipRow}>
          {COMMON_CONDITIONS.map(c => (
            <TouchableOpacity
              key={c}
              style={[s.chip, conditions.includes(c) && s.chipActive]}
              onPress={() => toggleChip(condSec, c)}
            >
              <Text style={[s.chipTxt, conditions.includes(c) && s.chipTxtActive]}>{c}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[s.chip, condOther && s.chipActive]} onPress={() => toggleOther(condSec)}>
            <Text style={[s.chipTxt, condOther && s.chipTxtActive]}>Other</Text>
          </TouchableOpacity>
        </View>
        {renderOther(condSec)}

        <Text style={s.label}>Medicine Allergies</Text>
        <View style={s.chipRow}>
          {COMMON_ALLERGIES.map(a => (
            <TouchableOpacity
              key={a}
              style={[s.chip, allergies.includes(a) && s.chipActive]}
              onPress={() => toggleChip(allgSec, a)}
            >
              <Text style={[s.chipTxt, allergies.includes(a) && s.chipTxtActive]}>{a}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[s.chip, allgOther && s.chipActive]} onPress={() => toggleOther(allgSec)}>
            <Text style={[s.chipTxt, allgOther && s.chipTxtActive]}>Other</Text>
          </TouchableOpacity>
        </View>
        {renderOther(allgSec)}

        <Text style={s.label}>Emergency Contact (optional)</Text>
        <TextInput
          style={s.input}
          placeholder="Phone number"
          placeholderTextColor={Colors.textSecondary}
          value={emergency}
          onChangeText={setEmergency}
          keyboardType="phone-pad"
        />

        {!!error && <Text style={s.error}>{error}</Text>}

        <TouchableOpacity
          style={[s.btn, loading && s.btnDisabled]}
          onPress={handleComplete}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color={Colors.white} />
            : <Text style={s.btnTxt}>Complete Setup</Text>
          }
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: Colors.bg },
  content:      { padding: 24, paddingBottom: 48 },
  header:       { backgroundColor: Colors.primary, margin: -24, marginBottom: 28, padding: 24, paddingTop: 48 },
  title:        { fontSize: 22, fontWeight: "bold", color: Colors.white },
  sub:          { fontSize: 13, color: Colors.primaryPale, marginTop: 4 },
  label:        { fontSize: 13, fontWeight: "600", color: Colors.textSecondary, marginBottom: 10, marginTop: 20, textTransform: "uppercase", letterSpacing: 0.5 },
  input:        { backgroundColor: Colors.card, borderRadius: 12, padding: 14, fontSize: 14, color: Colors.textPrimary, borderWidth: 1, borderColor: Colors.primaryPale },
  chipRow:      { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip:         { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.primaryPale },
  chipActive:   { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipTxt:      { fontSize: 13, color: Colors.textSecondary },
  chipTxtActive:{ color: Colors.white, fontWeight: "600" },
  otherRow:     { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  otherInput:   { flex: 1, paddingVertical: 10 },
  otherAdd:     { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  pillRow:      { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  pill:         { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: Colors.primary },
  pillTxt:      { fontSize: 13, color: Colors.white, fontWeight: "600" },
  error:        { color: Colors.alertRed, fontSize: 13, marginTop: 12, textAlign: "center" },
  btn:          { backgroundColor: Colors.primary, borderRadius: 30, paddingVertical: 16, alignItems: "center", marginTop: 28 },
  btnDisabled:  { opacity: 0.6 },
  btnTxt:       { color: Colors.white, fontSize: 16, fontWeight: "600" },
});
