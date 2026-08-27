import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { doc, updateDoc, setDoc } from "firebase/firestore";
import { auth, db } from "@/config/firebaseServices";
import { FIRESTORE, withoutHealthSentinels } from "@mediguard/shared";
import { useAuthStore } from "@/store/authStore";

function resizeToDataURL(file: File, size = 200, quality = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext("2d")!;
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ProfilePage() {
  const navigate            = useNavigate();
  const { user, setUser }   = useAuthStore();
  const [editing, setEditing]   = useState(false);
  const [name, setName]         = useState(user?.name ?? "");
  const [emergency, setEmergency] = useState(user?.emergencyContact ?? "");
  const [saving, setSaving]     = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef            = useRef<HTMLInputElement>(null);

  const initials = user?.name
    ? user.name.trim().split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 2)
    : (user?.email ?? "U").slice(0, 2).toUpperCase();

  // "Normal"/"None" are the form's "nothing to declare" sentinels, not entries —
  // a red "None" pill would read as a real allergen.
  const conditions = withoutHealthSentinels(user?.conditions);
  const allergies  = withoutHealthSentinels(user?.allergies);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;
    setUploading(true);
    try {
      const dataURL = await resizeToDataURL(file);
      await setDoc(doc(db(), FIRESTORE.USERS, user.id), { profilePhotoURL: dataURL }, { merge: true });
      setUser({ ...user, profilePhotoURL: dataURL });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleSave() {
    if (!user?.id) return;
    setSaving(true);
    await updateDoc(doc(db(), FIRESTORE.USERS, user.id), { name, emergencyContact: emergency });
    setUser({ ...user, name, emergencyContact: emergency });
    setEditing(false);
    setSaving(false);
  }

  async function handleLogout() {
    if (confirm("Sign out of MediGuard?")) {
      await signOut(auth());
      navigate("/login", { replace: true });
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-text-primary mb-6">Profile</h1>

      {/* Avatar + info */}
      <div className="bg-primary rounded-2xl p-6 mb-4 text-white">
        <div className="flex items-center gap-5">
          {/* Clickable avatar */}
          <div className="relative shrink-0">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="relative w-20 h-20 rounded-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-white/60 group"
              title="Change photo"
            >
              {user?.profilePhotoURL ? (
                <img src={user.profilePhotoURL} alt="Profile" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-white/20 flex items-center justify-center text-2xl font-bold">
                  {initials}
                </div>
              )}
              {/* Camera overlay on hover */}
              <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity ${uploading ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                {uploading ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span className="text-white text-lg">📷</span>
                )}
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhotoChange}
            />
          </div>

          <div>
            <p className="text-xl font-bold">{user?.name ?? "User"}</p>
            <p className="text-sm opacity-75">{user?.email}</p>
            <span className="mt-1.5 inline-block px-3 py-0.5 bg-white/20 rounded-full text-xs font-semibold capitalize">
              {user?.role === "careGuardian" ? "Care Guardian" : "Patient"}
            </span>
            <p className="text-xs opacity-60 mt-1">Tap photo to change</p>
          </div>
        </div>
      </div>

      {/* Edit toggle */}
      <div className="bg-card rounded-2xl shadow-sm border border-gray-100 p-5 mb-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-text-primary">Account Info</h2>
          {!editing
            ? <button onClick={() => setEditing(true)} className="text-sm text-primary hover:underline">Edit</button>
            : <div className="flex gap-2">
                <button onClick={() => setEditing(false)} className="text-sm text-text-secondary hover:underline">Cancel</button>
                <button onClick={handleSave} disabled={saving} className="text-sm text-primary font-semibold hover:underline disabled:opacity-60">
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
          }
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-xs text-text-secondary mb-0.5">Full Name</p>
            {editing
              ? <input value={name} onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              : <p className="text-sm font-medium text-text-primary">{user?.name || "—"}</p>
            }
          </div>
          <div>
            <p className="text-xs text-text-secondary mb-0.5">Email</p>
            <p className="text-sm text-text-primary">{user?.email}</p>
          </div>
          <div>
            <p className="text-xs text-text-secondary mb-0.5">Member Since</p>
            <p className="text-sm text-text-primary">{user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-text-secondary mb-0.5">Emergency Contact</p>
            {editing
              ? <input value={emergency} onChange={(e) => setEmergency(e.target.value)} placeholder="+91 9876543210"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              : <p className="text-sm text-text-primary">{user?.emergencyContact || "—"}</p>
            }
          </div>
        </div>
      </div>

      {/* Health profile */}
      <div className="bg-card rounded-2xl shadow-sm border border-gray-100 p-5 mb-4">
        <h2 className="font-bold text-text-primary mb-3">Health Profile</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            ["Blood Group",   user?.bloodGroup],
            ["Gender",        user?.gender],
            ["Date of Birth", user?.dateOfBirth],
          ].map(([label, val]) => (
            <div key={label as string}>
              <p className="text-xs text-text-secondary mb-0.5">{label as string}</p>
              <p className="font-medium text-text-primary">{val || "—"}</p>
            </div>
          ))}
        </div>

        {conditions.length > 0 && (
          <div className="mt-3">
            <p className="text-xs text-text-secondary mb-1.5">Conditions</p>
            <div className="flex flex-wrap gap-1.5">
              {conditions.map((c) => (
                <span key={c} className="px-2.5 py-0.5 bg-primary-pale text-primary text-xs rounded-full font-medium">{c}</span>
              ))}
            </div>
          </div>
        )}
        {allergies.length > 0 && (
          <div className="mt-3">
            <p className="text-xs text-text-secondary mb-1.5">Allergies</p>
            <div className="flex flex-wrap gap-1.5">
              {allergies.map((a) => (
                <span key={a} className="px-2.5 py-0.5 bg-red-50 text-alert-red text-xs rounded-full font-medium">{a}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Care Guardian Code — patients only */}
      {user?.role === "patient" && user.careGuardianCode && (
        <div className="bg-card rounded-2xl shadow-sm border border-primary/30 p-5 mb-4">
          <h2 className="font-bold text-text-primary mb-3">Care Guardian Code</h2>
          <div className="bg-primary-pale rounded-xl py-4 px-6 text-center mb-3 border border-primary/20">
            <p className="text-2xl font-extrabold text-primary tracking-[0.2em]">{user.careGuardianCode}</p>
          </div>
          <p className="text-xs text-text-secondary text-center">Share this code with your Care Guardian so they can monitor your medicines.</p>
        </div>
      )}

      <button onClick={handleLogout}
        className="w-full py-3 border border-alert-red text-alert-red rounded-xl text-sm font-semibold hover:bg-red-50 transition-colors">
        🚪 Sign Out
      </button>
    </div>
  );
}
