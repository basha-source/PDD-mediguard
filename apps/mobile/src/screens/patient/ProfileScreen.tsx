import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, Share, Image,
} from "react-native";
import { pickAndUploadProfilePhoto } from "@/services/profilePhoto";
import { useState, useEffect } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Colors }        from "@mediguard/shared";
import { signOutUser, getDb }   from "@mediguard/firebase";
import { setDoc, doc }   from "firebase/firestore";
import { FIRESTORE }     from "@mediguard/shared";
import { useAuthStore }  from "@/store/authStore";

export function ProfileScreen() {
  const user              = useAuthStore((s) => s.user);
  const setUser           = useAuthStore((s) => s.setUser);
  const [busy, setBusy]   = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cgCode, setCgCode] = useState<string>(user?.careGuardianCode ?? "");

  // Generate and persist a Care Guardian Code if the patient doesn't have one yet
  useEffect(() => {
    async function ensureCgCode() {
      if (!user || user.role !== "patient") return;
      const db = getDb();

      // Publish code -> patientId so a Care Guardian who knows only the MG-XXXX
      // code can resolve the patient by document ID. Security rules cannot
      // authorise a query, so the old `where("careGuardianCode","==",code)`
      // lookup against /users was always denied and linking could never succeed.
      async function publishCode(code: string) {
        await setDoc(
          doc(db, FIRESTORE.PATIENT_CODES, code),
          { patientId: user!.id, createdAt: new Date().toISOString() },
          { merge: true }
        );
      }

      if (user.careGuardianCode) {
        setCgCode(user.careGuardianCode);
        // Backfill: patients who got a code before the directory existed still
        // need an entry, otherwise their guardian can never link to them.
        publishCode(user.careGuardianCode).catch(() => {});
        return;
      }
      try {
        const code = "MG-" + Math.random().toString(36).substring(2, 6).toUpperCase();
        await setDoc(
          doc(db, FIRESTORE.USERS, user.id),
          { careGuardianCode: code },
          { merge: true }
        );
        await publishCode(code);
        setCgCode(code);
        setUser({ ...user, careGuardianCode: code });
      } catch {
        // Non-fatal — code will be generated next launch
      }
    }
    ensureCgCode();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleShareCode() {
    if (!cgCode) return;
    try {
      await Share.share({
        message: `My MediGuard Care Guardian code is: ${cgCode}\n\nDownload MediGuard and use this code to monitor my medicines.`,
        title: "My MediGuard Code",
      });
    } catch {
      // User dismissed share sheet — no-op
    }
  }

  const initials = user?.name
    ? user.name.trim().split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2)
    : "?";

  const roleLabel = user?.role === "careGuardian" ? "Care Guardian" : "Patient";

  function confirmLogout() {
    Alert.alert("Log Out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log Out",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await signOutUser();
            // onAuthStateChanged fires → clears authStore → RootNavigator shows AuthStack
          } catch {
            Alert.alert("Error", "Logout failed. Please try again.");
            setBusy(false);
          }
        },
      },
    ]);
  }

  async function handlePhotoChange() {
    if (!user) return;
    setUploading(true);
    try {
      const url = await pickAndUploadProfilePhoto(user.id);
      if (url) setUser({ ...user, profilePhotoURL: url });
    } finally {
      setUploading(false);
    }
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* Avatar */}
      <View style={s.avatarWrap}>
        <TouchableOpacity onPress={handlePhotoChange} disabled={uploading} activeOpacity={0.8} style={s.avatarTouchable}>
          {user?.profilePhotoURL ? (
            <Image source={{ uri: user.profilePhotoURL }} style={s.avatarImg} />
          ) : (
            <View style={s.avatar}>
              <Text style={s.avatarTxt}>{initials}</Text>
            </View>
          )}
          <View style={s.cameraOverlay}>
            {uploading
              ? <ActivityIndicator size="small" color={Colors.white} />
              : <Ionicons name="camera" size={14} color={Colors.white} />}
          </View>
        </TouchableOpacity>
        <Text style={s.name}>{user?.name || "—"}</Text>
        <Text style={s.email}>{user?.email || "—"}</Text>
        <View style={s.roleBadge}>
          <Text style={s.roleTxt}>{roleLabel}</Text>
        </View>
      </View>

      {/* Health details */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>Health Profile</Text>

        <Row label="Blood Group" value={user?.bloodGroup || "Not set"} />
        <Row label="Conditions"  value={user?.conditions?.join(", ") || "None"} />
        <Row label="Allergies"   value={user?.allergies?.join(", ") || "None"} />
        <Row label="Emergency"   value={user?.emergencyContact || "Not set"} />
      </View>

      {/* Account */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>Account</Text>
        <Row label="Member since" value={user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"} />
      </View>

      {/* Care Guardian Code — only shown to patients */}
      {user?.role === "patient" && (
        <View style={s.cgSection}>
          <Text style={s.sectionTitle}>Care Guardian Code</Text>

          <View style={s.codeBox}>
            {cgCode ? (
              <Text style={s.codeTxt}>{cgCode}</Text>
            ) : (
              <ActivityIndicator color={Colors.primary} />
            )}
          </View>

          <TouchableOpacity
            style={s.shareBtn}
            onPress={handleShareCode}
            disabled={!cgCode}
            activeOpacity={0.8}
          >
            <Ionicons name="share-outline" size={18} color={Colors.white} />
            <Text style={s.shareBtnTxt}>Share Code</Text>
          </TouchableOpacity>

          <Text style={s.cgHint}>
            Share this code with your Care Guardian so they can monitor your medicines.
          </Text>
        </View>
      )}

      {/* Logout */}
      <TouchableOpacity
        style={[s.logoutBtn, busy && s.btnDisabled]}
        onPress={confirmLogout}
        disabled={busy}
      >
        {busy
          ? <ActivityIndicator color={Colors.alertRed} />
          : <Text style={s.logoutTxt}>Log Out</Text>
        }
      </TouchableOpacity>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: Colors.bg },
  content:      { padding: 24, paddingBottom: 48 },

  avatarWrap:   { alignItems: "center", paddingVertical: 32 },
  avatar:       { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  avatarTxt:    { fontSize: 28, fontWeight: "bold", color: Colors.white },
  name:         { fontSize: 20, fontWeight: "700", color: Colors.textPrimary, marginBottom: 4 },
  email:        { fontSize: 14, color: Colors.textSecondary, marginBottom: 10 },
  roleBadge:    { backgroundColor: Colors.primaryPale, paddingHorizontal: 16, paddingVertical: 4, borderRadius: 20 },
  roleTxt:      { fontSize: 13, fontWeight: "600", color: Colors.primary },

  avatarTouchable: { position: "relative", marginBottom: 12 },
  avatarImg:       { width: 80, height: 80, borderRadius: 40 },
  cameraOverlay:   {
    position: "absolute", bottom: 0, right: 0,
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: Colors.primary,
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: Colors.white,
  },

  section:      { backgroundColor: Colors.card, borderRadius: 16, padding: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: Colors.textSecondary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 },
  row:          { flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.primaryPale },
  rowLabel:     { fontSize: 14, color: Colors.textSecondary, flex: 1 },
  rowValue:     { fontSize: 14, color: Colors.textPrimary, fontWeight: "500", flex: 2, textAlign: "right" },

  // Care Guardian Code section
  cgSection:    {
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1.5,
    borderColor: Colors.primaryLight,
  },
  codeBox:      {
    backgroundColor: Colors.primaryPale,
    borderRadius: 12,
    paddingVertical: 18,
    paddingHorizontal: 24,
    alignItems: "center",
    marginBottom: 14,
    borderWidth: 1,
    borderColor: Colors.primaryLight,
  },
  codeTxt:      {
    fontSize: 28,
    fontWeight: "800",
    color: Colors.greenDark,
    letterSpacing: 4,
    fontVariant: ["tabular-nums"],
  },
  shareBtn:     {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
    marginBottom: 12,
  },
  shareBtnTxt:  { fontSize: 14, fontWeight: "700", color: Colors.white },
  cgHint:       { fontSize: 12, color: Colors.textSecondary, textAlign: "center", lineHeight: 18 },

  logoutBtn:    { borderRadius: 30, paddingVertical: 16, alignItems: "center", borderWidth: 1.5, borderColor: Colors.alertRed },
  btnDisabled:  { opacity: 0.5 },
  logoutTxt:    { fontSize: 16, fontWeight: "600", color: Colors.alertRed },
});
