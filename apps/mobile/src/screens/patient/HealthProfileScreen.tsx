import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { doc, setDoc } from "firebase/firestore";
import { getDb } from "@mediguard/firebase";
import { Colors, FIRESTORE } from "@mediguard/shared";
import { useAuthStore } from "@/store/authStore";

const GENDERS = ["Male", "Female", "Other", "Prefer not to say"];
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

/* Must stay in sync with auth/HealthConditionsScreen.tsx */
const NO_CONDITIONS     = "Normal";
const NO_ALLERGIES      = "None";
const COMMON_CONDITIONS = ["Normal", "Diabetes", "Hypertension", "Asthma", "Heart Disease", "Thyroid"];
const COMMON_ALLERGIES  = ["None", "Penicillin", "Aspirin", "Ibuprofen", "Sulfa drugs", "Codeine"];

/* sentinel ("Normal"/"None") is exclusive: picking it clears the rest, picking anything else drops it */
function toggleWithSentinel(
  list: string[],
  setList: (v: string[]) => void,
  item: string,
  sentinel: string,
) {
  if (item === sentinel) { setList(list.includes(item) ? [] : [sentinel]); return; }
  const next = list.includes(item) ? list.filter((i) => i !== item) : [...list, item];
  setList(next.filter((i) => i !== sentinel));
}

/* anything stored that is not a preset chip is a free-text "Other" value */
function customEntries(list: string[], presets: string[]) {
  return list.filter((v) => !presets.includes(v));
}

type ChipFieldProps = {
  label:         string;
  presets:       string[];
  sentinel:      string;
  list:          string[];
  setList:       (v: string[]) => void;
  otherOpen:     boolean;
  setOtherOpen:  (v: boolean) => void;
  otherInput:    string;
  setOtherInput: (v: string) => void;
  placeholder:   string;
  last?:         boolean;
};

/* Shared chip row + "Other" free-text input + removable pills, used by Conditions and Allergies */
function ChipField({
  label, presets, sentinel, list, setList,
  otherOpen, setOtherOpen, otherInput, setOtherInput, placeholder, last,
}: ChipFieldProps) {
  const customs = customEntries(list, presets);

  function pressChip(item: string) {
    toggleWithSentinel(list, setList, item, sentinel);
    if (item === sentinel && !list.includes(sentinel)) {
      setOtherOpen(false);
      setOtherInput("");
    }
  }

  function pressOther() {
    if (!otherOpen) {
      setOtherOpen(true);
      setList(list.filter((i) => i !== sentinel));
      return;
    }
    if (customs.length) return;          // cannot close while custom pills are showing
    setOtherOpen(false);
    setOtherInput("");
  }

  function addCustom() {
    const value = otherInput.trim();
    if (!value) return;
    const lower = value.toLowerCase();

    if (lower === sentinel.toLowerCase()) {
      setList([sentinel]);
      setOtherOpen(false);
      setOtherInput("");
      return;
    }

    const preset = presets.find((p) => p.toLowerCase() === lower);
    if (preset) {
      if (!list.includes(preset)) toggleWithSentinel(list, setList, preset, sentinel);
      setOtherInput("");
      return;
    }

    if (list.some((i) => i.toLowerCase() === lower)) { setOtherInput(""); return; }

    setList([...list.filter((i) => i !== sentinel), value]);
    setOtherInput("");
  }

  function removeCustom(value: string) {
    setList(list.filter((i) => i !== value));
  }

  return (
    <View style={[s.multiRow, last && s.rowLast]}>
      <Text style={s.rowLabel}>{label}</Text>

      <View style={s.chipRow}>
        {presets.map((item) => (
          <TouchableOpacity
            key={item}
            style={[s.chip, list.includes(item) && s.chipActive]}
            onPress={() => pressChip(item)}
            activeOpacity={0.8}
          >
            <Text style={[s.chipTxt, list.includes(item) && s.chipTxtActive]}>{item}</Text>
          </TouchableOpacity>
        ))}

        {/* "Other" is a UI affordance only - never written to the saved array */}
        <TouchableOpacity
          style={[s.chip, otherOpen && s.chipActive]}
          onPress={pressOther}
          activeOpacity={0.8}
        >
          <Text style={[s.chipTxt, otherOpen && s.chipTxtActive]}>Other</Text>
        </TouchableOpacity>
      </View>

      {otherOpen && (
        <View style={s.otherRow}>
          <TextInput
            style={s.otherInput}
            value={otherInput}
            onChangeText={setOtherInput}
            onSubmitEditing={addCustom}
            placeholder={placeholder}
            placeholderTextColor={Colors.textSecondary}
            returnKeyType="done"
            blurOnSubmit={false}
          />
          <TouchableOpacity style={s.addBtn} onPress={addCustom} activeOpacity={0.8}>
            <Ionicons name="add" size={18} color={Colors.white} />
          </TouchableOpacity>
        </View>
      )}

      {customs.length > 0 && (
        <View style={s.pillRow}>
          {customs.map((value) => (
            <View key={value} style={s.pill}>
              <Text style={s.pillTxt}>{value}</Text>
              <TouchableOpacity onPress={() => removeCustom(value)} hitSlop={8}>
                <Ionicons name="close" size={14} color={Colors.primary} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function HealthProfileScreen() {
  const navigation = useNavigation();
  const user    = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [name,             setName]             = useState(user?.name ?? "");
  const [dob,              setDob]              = useState(user?.dateOfBirth ?? "");
  const [gender,           setGender]           = useState(user?.gender ?? "");
  const [bloodGroup,       setBloodGroup]       = useState(user?.bloodGroup ?? "");
  const [conditions,       setConditions]       = useState<string[]>(user?.conditions ?? []);
  const [allergies,        setAllergies]        = useState<string[]>(user?.allergies ?? []);
  const [emergencyContact, setEmergencyContact] = useState(user?.emergencyContact ?? "");
  const [saving,           setSaving]           = useState(false);

  /* open the free-text field up front when stored values include non-preset entries */
  const [condOtherOpen,  setCondOtherOpen]  = useState(
    () => customEntries(user?.conditions ?? [], COMMON_CONDITIONS).length > 0,
  );
  const [condOtherInput, setCondOtherInput] = useState("");
  const [allgOtherOpen,  setAllgOtherOpen]  = useState(
    () => customEntries(user?.allergies ?? [], COMMON_ALLERGIES).length > 0,
  );
  const [allgOtherInput, setAllgOtherInput] = useState("");

  const [showGenderPicker, setShowGenderPicker] = useState(false);
  const [showBloodPicker,  setShowBloodPicker]  = useState(false);

  async function saveProfile() {
    if (!user) return;
    setSaving(true);
    try {
      const updates = {
        name:             name.trim() || user.name,
        dateOfBirth:      dob.trim(),
        gender:           gender,
        bloodGroup:       bloodGroup,
        conditions:       conditions,
        allergies:        allergies,
        emergencyContact: emergencyContact.trim(),
      };
      await setDoc(doc(getDb(), FIRESTORE.USERS, user.id), updates, { merge: true });
      setUser({ ...user, ...updates });
      Alert.alert("Saved", "Your health profile has been updated.");
    } catch {
      Alert.alert("Error", "Could not save profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={Colors.white} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Health Profile</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={s.root}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Personal Info ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Personal Info</Text>

          {/* Name */}
          <View style={s.row}>
            <Text style={s.rowLabel}>Name</Text>
            <TextInput
              style={s.rowInput}
              value={name}
              onChangeText={setName}
              placeholder="Full name"
              placeholderTextColor={Colors.textSecondary}
              returnKeyType="next"
            />
          </View>

          {/* DOB */}
          <View style={s.row}>
            <Text style={s.rowLabel}>Date of Birth</Text>
            <TextInput
              style={s.rowInput}
              value={dob}
              onChangeText={setDob}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={Colors.textSecondary}
              keyboardType="numbers-and-punctuation"
              returnKeyType="next"
              maxLength={10}
            />
          </View>

          {/* Gender picker */}
          <View style={[s.row, s.rowLast]}>
            <Text style={s.rowLabel}>Gender</Text>
            <TouchableOpacity
              style={s.pickerTrigger}
              onPress={() => {
                setShowBloodPicker(false);
                setShowGenderPicker((v) => !v);
              }}
              activeOpacity={0.8}
            >
              <Text style={[s.pickerValue, !gender && s.pickerPlaceholder]}>
                {gender || "Select"}
              </Text>
              <Ionicons
                name={showGenderPicker ? "chevron-up" : "chevron-down"}
                size={16}
                color={Colors.textSecondary}
              />
            </TouchableOpacity>
          </View>

          {showGenderPicker && (
            <View style={s.dropdown}>
              {GENDERS.map((opt) => (
                <TouchableOpacity
                  key={opt}
                  style={[s.dropdownItem, gender === opt && s.dropdownItemActive]}
                  onPress={() => {
                    setGender(opt);
                    setShowGenderPicker(false);
                  }}
                >
                  <Text style={[s.dropdownItemText, gender === opt && s.dropdownItemTextActive]}>
                    {opt}
                  </Text>
                  {gender === opt && (
                    <Ionicons name="checkmark" size={16} color={Colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* ── Medical Info ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Medical Info</Text>

          {/* Blood Group picker */}
          <View style={s.row}>
            <Text style={s.rowLabel}>Blood Group</Text>
            <TouchableOpacity
              style={s.pickerTrigger}
              onPress={() => {
                setShowGenderPicker(false);
                setShowBloodPicker((v) => !v);
              }}
              activeOpacity={0.8}
            >
              <Text style={[s.pickerValue, !bloodGroup && s.pickerPlaceholder]}>
                {bloodGroup || "Select"}
              </Text>
              <Ionicons
                name={showBloodPicker ? "chevron-up" : "chevron-down"}
                size={16}
                color={Colors.textSecondary}
              />
            </TouchableOpacity>
          </View>

          {showBloodPicker && (
            <View style={s.dropdown}>
              {BLOOD_GROUPS.map((opt) => (
                <TouchableOpacity
                  key={opt}
                  style={[s.dropdownItem, bloodGroup === opt && s.dropdownItemActive]}
                  onPress={() => {
                    setBloodGroup(opt);
                    setShowBloodPicker(false);
                  }}
                >
                  <Text style={[s.dropdownItemText, bloodGroup === opt && s.dropdownItemTextActive]}>
                    {opt}
                  </Text>
                  {bloodGroup === opt && (
                    <Ionicons name="checkmark" size={16} color={Colors.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Conditions */}
          <ChipField
            label="Conditions"
            presets={COMMON_CONDITIONS}
            sentinel={NO_CONDITIONS}
            list={conditions}
            setList={setConditions}
            otherOpen={condOtherOpen}
            setOtherOpen={setCondOtherOpen}
            otherInput={condOtherInput}
            setOtherInput={setCondOtherInput}
            placeholder="Add another condition"
          />

          {/* Allergies */}
          <ChipField
            label="Allergies"
            presets={COMMON_ALLERGIES}
            sentinel={NO_ALLERGIES}
            list={allergies}
            setList={setAllergies}
            otherOpen={allgOtherOpen}
            setOtherOpen={setAllgOtherOpen}
            otherInput={allgOtherInput}
            setOtherInput={setAllgOtherInput}
            placeholder="Add another allergy"
            last
          />
        </View>

        {/* ── Emergency Contact ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Emergency Contact</Text>
          <View style={[s.row, s.rowLast]}>
            <Text style={s.rowLabel}>Name & Phone</Text>
            <TextInput
              style={s.rowInput}
              value={emergencyContact}
              onChangeText={setEmergencyContact}
              placeholder="e.g. Jane Doe +91 98765 43210"
              placeholderTextColor={Colors.textSecondary}
              returnKeyType="done"
            />
          </View>
        </View>

        {/* ── Save Button ── */}
        <TouchableOpacity
          style={[s.saveBtn, saving && s.saveBtnDisabled]}
          onPress={saveProfile}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <Text style={s.saveBtnText}>SAVE PROFILE</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root:    { flex: 1, backgroundColor: Colors.bg },
  content: { padding: 16, paddingBottom: 48 },

  /* Header */
  header: {
    backgroundColor:  Colors.primary,
    paddingTop:       52,
    paddingBottom:    16,
    paddingHorizontal: 16,
    flexDirection:    "row",
    alignItems:       "center",
    justifyContent:   "space-between",
  },
  backBtn:     { width: 40, alignItems: "flex-start" },
  headerTitle: { fontSize: 18, fontWeight: "700", color: Colors.white },

  /* Sections */
  section: {
    backgroundColor: Colors.card,
    borderRadius:    16,
    padding:         16,
    marginBottom:    16,
  },
  sectionTitle: {
    fontSize:        12,
    fontWeight:      "700",
    color:           Colors.textSecondary,
    textTransform:   "uppercase",
    letterSpacing:   0.5,
    marginBottom:    12,
  },

  /* Regular field row */
  row: {
    flexDirection:   "row",
    alignItems:      "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.primaryPale,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: {
    flex:     1,
    fontSize: 14,
    color:    Colors.textSecondary,
  },
  rowInput: {
    flex:        2,
    fontSize:    14,
    color:       Colors.textPrimary,
    textAlign:   "right",
    paddingVertical: 0,
  },

  /* Picker trigger */
  pickerTrigger: {
    flex:           2,
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "flex-end",
    gap:            6,
  },
  pickerValue:       { fontSize: 14, color: Colors.textPrimary, fontWeight: "500" },
  pickerPlaceholder: { color: Colors.textSecondary, fontWeight: "400" },

  /* Inline dropdown */
  dropdown: {
    backgroundColor: Colors.card,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     Colors.primaryLight,
    marginTop:       4,
    marginBottom:    8,
    overflow:        "hidden",
    zIndex:          10,
  },
  dropdownItem: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "space-between",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.primaryPale,
  },
  dropdownItemActive:     { backgroundColor: Colors.primaryPale },
  dropdownItemText:       { fontSize: 14, color: Colors.textPrimary },
  dropdownItemTextActive: { color: Colors.primary, fontWeight: "600" },

  /* Chip field rows (conditions/allergies) */
  multiRow: {
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.primaryPale,
  },

  /* Chips - shape copied from auth/HealthConditionsScreen.tsx */
  chipRow:       { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical:   8,
    borderRadius:      20,
    backgroundColor:   Colors.card,
    borderWidth:       1,
    borderColor:       Colors.primaryPale,
  },
  chipActive:    { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipTxt:       { fontSize: 13, color: Colors.textSecondary },
  chipTxtActive: { color: Colors.white, fontWeight: "600" },

  /* "Other" free-text input */
  otherRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginTop:     10,
  },
  otherInput: {
    flex:              1,
    fontSize:          14,
    color:             Colors.textPrimary,
    paddingVertical:   8,
    paddingHorizontal: 12,
    backgroundColor:   Colors.bg,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       Colors.primaryPale,
  },
  addBtn: {
    width:           34,
    height:          34,
    borderRadius:    17,
    backgroundColor: Colors.primary,
    alignItems:      "center",
    justifyContent:  "center",
  },

  /* Custom-value pills */
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  pill: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      20,
    backgroundColor:   Colors.primaryPale,
  },
  pillTxt: { fontSize: 13, color: Colors.primary, fontWeight: "600" },

  /* Save button */
  saveBtn: {
    backgroundColor: Colors.primary,
    borderRadius:    30,
    paddingVertical: 16,
    alignItems:      "center",
    marginTop:       4,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: {
    fontSize:    16,
    fontWeight:  "700",
    color:       Colors.white,
    letterSpacing: 1,
  },
});
