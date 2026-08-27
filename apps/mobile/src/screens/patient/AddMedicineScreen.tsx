import { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { StackNavigationProp } from "@react-navigation/stack";
import { Ionicons } from "@expo/vector-icons";
import { collection, addDoc, doc, updateDoc } from "firebase/firestore";
import { getDb } from "@mediguard/firebase";
import { Colors, FIRESTORE, MedicineCategory } from "@mediguard/shared";
import { useAuthStore } from "@/store/authStore";
import { useMedicineStore } from "@/store/medicineStore";
import { scheduleLowStockAlert, addInAppNotification } from "@/services/notifications";
import { recordBarcode } from "@/services/barcodeRegistry";
import { InventoryStackParams } from "@/navigation/PatientTabs";

type Nav   = StackNavigationProp<InventoryStackParams, "AddMedicine">;
type Route = RouteProp<InventoryStackParams, "AddMedicine">;

const CATEGORIES: { key: MedicineCategory; label: string }[] = [
  { key: "tablet",    label: "Tablet" },
  { key: "capsule",   label: "Capsule" },
  { key: "liquid",    label: "Liquid" },
  { key: "injection", label: "Injection" },
  { key: "other",     label: "Other" },
];

export function AddMedicineScreen() {
  const navigation = useNavigation<Nav>();
  const route      = useRoute<Route>();
  const user       = useAuthStore((s) => s.user);
  const medicines  = useMedicineStore((s) => s.medicines);

  const editId   = route.params?.medicineId;
  const existing = editId ? medicines.find((m) => m.id === editId) : undefined;

  const prefillName     = route.params?.prefillName;
  const prefillDosage   = route.params?.prefillDosage;
  const prefillCategory = route.params?.prefillCategory;
  const prefillExpiry   = route.params?.prefillExpiry;

  // The code this screen was reached from, when it was reached from a scan.
  // Read off the params object directly because the stack's param list does not
  // declare it yet; typed access is restored once ScannerScreen's change lands.
  // On an edit the params carry nothing, so fall back to the code the medicine
  // was originally stored with -- that is the barcode this form is describing.
  const scannedBarcode = (route.params as { barcode?: string } | undefined)?.barcode;
  const barcode        = scannedBarcode ?? existing?.barcode;

  const parseDate = (iso?: string) => {
    if (!iso) return { dd: "", mm: "", yyyy: "" };
    const d = new Date(iso);
    return {
      dd:   d.getDate().toString().padStart(2, "0"),
      mm:   (d.getMonth() + 1).toString().padStart(2, "0"),
      yyyy: d.getFullYear().toString(),
    };
  };

  const ed = parseDate(existing?.expiryDate ?? prefillExpiry ?? "");

  const [name,         setName]         = useState(existing?.name         ?? prefillName     ?? "");
  const [dosage,       setDosage]       = useState(existing?.dosage       ?? prefillDosage   ?? "");
  const [quantity,     setQuantity]     = useState(existing?.quantity?.toString() ?? "");
  const [prescribedBy, setPrescribedBy] = useState(existing?.prescribedBy ?? "");
  const [category,     setCategory]     = useState<MedicineCategory>(existing?.category ?? prefillCategory ?? "tablet");
  const [dd,   setDd]   = useState(ed.dd);
  const [mm,   setMm]   = useState(ed.mm);
  const [yyyy, setYyyy] = useState(ed.yyyy);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editId) return;
    if (prefillName     !== undefined) setName(prefillName);
    if (prefillDosage   !== undefined) setDosage(prefillDosage);
    if (prefillCategory !== undefined) setCategory(prefillCategory);
    if (prefillExpiry   !== undefined) {
      const d = parseDate(prefillExpiry);
      setDd(d.dd); setMm(d.mm); setYyyy(d.yyyy);
    }
  }, [prefillName, prefillDosage, prefillCategory, prefillExpiry, editId]);

  const buildISO = () => {
    const d  = parseInt(dd,   10);
    const mo = parseInt(mm,   10);
    const y  = parseInt(yyyy, 10);
    if (!d || !mo || !y || y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return new Date(y, mo - 1, d).toISOString();
  };

  const handleSave = async () => {
    if (!user) return;
    if (!name.trim())   { Alert.alert("Required", "Medicine name is required."); return; }
    if (!dosage.trim()) { Alert.alert("Required", "Dosage is required."); return; }
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 0) { Alert.alert("Invalid", "Enter a valid quantity."); return; }
    const isoDate = buildISO();
    if (!isoDate) { Alert.alert("Invalid Date", "Please enter a valid DD / MM / YYYY."); return; }

    setSaving(true);
    try {
      if (editId) {
        await updateDoc(doc(getDb(), FIRESTORE.MEDICINES, editId), {
          name: name.trim(), dosage: dosage.trim(), quantity: qty,
          expiryDate: isoDate, category, prescribedBy: prescribedBy.trim(),
          // Spread rather than `barcode` outright: Firestore rejects undefined,
          // and an edit with no code known must leave any stored one untouched.
          ...(barcode ? { barcode } : {}),
        });
      } else {
        await addDoc(collection(getDb(), FIRESTORE.MEDICINES), {
          userId: user.id, name: name.trim(), dosage: dosage.trim(),
          quantity: qty, expiryDate: isoDate, category,
          prescribedBy: prescribedBy.trim(), addedAt: new Date().toISOString(),
          ...(barcode ? { barcode } : {}),
        });
      }
      if (qty < 5) {
        scheduleLowStockAlert(name.trim()).catch(() => {});
        addInAppNotification(user.id, "Low Stock Alert", `${name.trim()} is running low (${qty} left). Time to reorder.`, "refill").catch(() => {});
      }
      // Teach the registry from the form, never from the prefill params. What
      // OpenFDA or OCR guessed is only worth caching once a human has looked at
      // it, and when the user overwrote that guess their correction is exactly
      // the answer the next scan of this box should get -- recording the params
      // instead would keep re-serving the wrong name forever. Runs for resolved
      // hits too, so a second scan skips the network entirely.
      //
      // Fire-and-forget like the low-stock calls above: the medicine is already
      // saved, so a registry write must never surface as "failed to save".
      if (barcode) {
        recordBarcode(user.id, barcode, {
          name: name.trim(), dosage: dosage.trim(), category,
        }).catch(() => {});
      }
      navigation.goBack();
    } catch {
      Alert.alert("Error", "Failed to save medicine. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={22} color={Colors.white} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>{editId ? "Edit Medicine" : "Add Medicine"}</Text>
          <View style={{ width: 38 }} />
        </View>

        <ScrollView contentContainerStyle={s.form}>
          <Field label="Medicine Name *">
            <TextInput
              style={s.input}
              placeholder="e.g. Paracetamol"
              placeholderTextColor={Colors.textSecondary}
              value={name}
              onChangeText={setName}
            />
          </Field>

          <Field label="Dosage *">
            <TextInput
              style={s.input}
              placeholder="e.g. 500mg"
              placeholderTextColor={Colors.textSecondary}
              value={dosage}
              onChangeText={setDosage}
            />
          </Field>

          <Field label="Quantity *">
            <TextInput
              style={s.input}
              placeholder="Number of tablets / ml"
              placeholderTextColor={Colors.textSecondary}
              keyboardType="numeric"
              value={quantity}
              onChangeText={(t) => setQuantity(t.replace(/[^0-9]/g, ""))}
            />
          </Field>

          <Field label="Expiry Date *">
            <View style={s.dateRow}>
              <TextInput
                style={[s.input, s.dateBox]}
                placeholder="DD"
                placeholderTextColor={Colors.textSecondary}
                keyboardType="numeric"
                maxLength={2}
                value={dd}
                onChangeText={(t) => setDd(t.replace(/[^0-9]/g, ""))}
              />
              <Text style={s.dateSep}>/</Text>
              <TextInput
                style={[s.input, s.dateBox]}
                placeholder="MM"
                placeholderTextColor={Colors.textSecondary}
                keyboardType="numeric"
                maxLength={2}
                value={mm}
                onChangeText={(t) => setMm(t.replace(/[^0-9]/g, ""))}
              />
              <Text style={s.dateSep}>/</Text>
              <TextInput
                style={[s.input, s.dateBoxYear]}
                placeholder="YYYY"
                placeholderTextColor={Colors.textSecondary}
                keyboardType="numeric"
                maxLength={4}
                value={yyyy}
                onChangeText={(t) => setYyyy(t.replace(/[^0-9]/g, ""))}
              />
            </View>
          </Field>

          <Field label="Category *">
            <View style={s.catRow}>
              {CATEGORIES.map((c) => (
                <TouchableOpacity
                  key={c.key}
                  style={[s.catChip, category === c.key && s.catChipActive]}
                  onPress={() => setCategory(c.key)}
                >
                  <Text style={[s.catChipText, category === c.key && s.catChipTextActive]}>
                    {c.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Field>

          <Field label="Prescribed By">
            <TextInput
              style={s.input}
              placeholder="Doctor's name (optional)"
              placeholderTextColor={Colors.textSecondary}
              value={prescribedBy}
              onChangeText={setPrescribedBy}
            />
          </Field>

          <TouchableOpacity
            style={[s.saveBtn, saving && s.saveBtnDisabled]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <>
                <Ionicons name="checkmark" size={20} color={Colors.white} />
                <Text style={s.saveBtnText}>{editId ? "Save Changes" : "Add Medicine"}</Text>
              </>
            )}
          </TouchableOpacity>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.fieldWrap}>
      <Text style={s.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  root:              { flex: 1, backgroundColor: Colors.bg },
  header:            { backgroundColor: Colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 52, paddingBottom: 16 },
  backBtn:           { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  headerTitle:       { fontSize: 18, fontWeight: "700", color: Colors.white },
  form:              { padding: 20, paddingBottom: 48 },
  fieldWrap:         { marginBottom: 20 },
  fieldLabel:        { fontSize: 13, fontWeight: "600", color: Colors.textPrimary, marginBottom: 8 },
  input:             { backgroundColor: Colors.card, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: Colors.textPrimary, borderWidth: 1, borderColor: "#E8E8E8" },
  dateRow:           { flexDirection: "row", alignItems: "center", gap: 8 },
  dateBox:           { flex: 2, textAlign: "center" },
  dateBoxYear:       { flex: 3, textAlign: "center", backgroundColor: Colors.card, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: Colors.textPrimary, borderWidth: 1, borderColor: "#E8E8E8" },
  dateSep:           { fontSize: 18, color: Colors.textSecondary, fontWeight: "300" },
  catRow:            { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  catChip:           { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: Colors.card, borderWidth: 1.5, borderColor: "#E0E0E0" },
  catChipActive:     { backgroundColor: Colors.primary, borderColor: Colors.primary },
  catChipText:       { fontSize: 13, color: Colors.textSecondary, fontWeight: "500" },
  catChipTextActive: { color: Colors.white },
  saveBtn:           { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: Colors.primary, borderRadius: 16, padding: 16, marginTop: 12, gap: 8 },
  saveBtnDisabled:   { opacity: 0.7 },
  saveBtnText:       { fontSize: 16, fontWeight: "700", color: Colors.white },
});
