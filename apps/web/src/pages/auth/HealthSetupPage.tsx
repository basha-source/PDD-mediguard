import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "@/config/firebaseServices";
import { FIRESTORE } from "@mediguard/shared";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const NO_CONDITIONS = "Normal";
const NO_ALLERGIES  = "None";
const COMMON_CONDITIONS = ["Normal", "Diabetes", "Hypertension", "Asthma", "Heart Disease", "Arthritis", "Thyroid", "Kidney Disease"];
const COMMON_ALLERGIES  = ["None", "Penicillin", "Aspirin", "Ibuprofen", "Sulfa drugs", "Codeine", "Latex"];

export function HealthSetupPage() {
  const navigate = useNavigate();
  const [name, setName]             = useState(auth().currentUser?.displayName ?? "");
  const [bloodGroup, setBloodGroup] = useState("");
  const [gender, setGender]         = useState("");
  const [dob, setDob]               = useState("");
  const [conditions, setConditions] = useState<string[]>([]);
  const [allergies, setAllergies]   = useState<string[]>([]);
  const [emergency, setEmergency]   = useState("");
  const [condInput, setCondInput]   = useState("");
  const [condOther, setCondOther]   = useState(() => conditions.some((x) => !COMMON_CONDITIONS.includes(x)));
  const [allergyInput, setAllergyInput] = useState("");
  const [allergyOther, setAllergyOther] = useState(() => allergies.some((x) => !COMMON_ALLERGIES.includes(x)));
  const [loading, setLoading]       = useState(false);

  function toggleItem(list: string[], setList: (v: string[]) => void, item: string, sentinel: string, setInput: (v: string) => void, setOther: (v: boolean) => void) {
    if (item === sentinel) { setList(list.includes(sentinel) ? [] : [sentinel]); setInput(""); setOther(false); return; }
    const next = list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
    setList(next.filter((x) => x !== sentinel));
  }
  function toggleOther(list: string[], setList: (v: string[]) => void, presets: string[], sentinel: string, open: boolean, setOpen: (v: boolean) => void, setInput: (v: string) => void) {
    if (!open) { setOpen(true); setList(list.filter((x) => x !== sentinel)); return; }
    if (list.some((x) => !presets.includes(x))) return;
    setOpen(false); setInput("");
  }
  function addCustom(input: string, list: string[], setList: (v: string[]) => void, setInput: (v: string) => void, sentinel: string, presets: string[], setOther: (v: boolean) => void) {
    const val = input.trim();
    if (!val) return;
    if (val.toLowerCase() === sentinel.toLowerCase()) { setList([sentinel]); setOther(false); setInput(""); return; }
    if (list.some((x) => x.toLowerCase() === val.toLowerCase())) { setInput(""); return; }
    const preset = presets.find((p) => p.toLowerCase() === val.toLowerCase());
    if (preset) { toggleItem(list, setList, preset, sentinel, setInput, setOther); setInput(""); return; }
    setList([...list.filter((x) => x !== sentinel), val]);
    setInput("");
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const fbUser = auth().currentUser;
    if (!fbUser) { navigate("/login", { replace: true }); return; }
    await setDoc(doc(db(), FIRESTORE.USERS, fbUser.uid), {
      name: name || (fbUser.email?.split("@")[0] ?? "User"),
      bloodGroup, gender, dateOfBirth: dob,
      conditions, allergies, emergencyContact: emergency,
    }, { merge: true });
    navigate("/", { replace: true });
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-xl">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-text-primary">Health Profile Setup</h1>
          <p className="text-text-secondary mt-1 text-sm">Help us personalise your experience (optional)</p>
        </div>
        <form onSubmit={handleSave} className="bg-card rounded-2xl shadow-lg p-8 space-y-5">
          <div>
            <label className="block text-sm font-medium mb-1.5">Full Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name"
              className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">Blood Group</label>
              <select value={bloodGroup} onChange={(e) => setBloodGroup(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white">
                <option value="">Select</option>
                {BLOOD_GROUPS.map((b) => <option key={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Gender</label>
              <select value={gender} onChange={(e) => setGender(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white">
                <option value="">Select</option><option>Male</option><option>Female</option><option>Other</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Date of Birth</label>
              <input type="date" value={dob} onChange={(e) => setDob(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Medical Conditions</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {COMMON_CONDITIONS.map((c) => (
                <button type="button" key={c} onClick={() => toggleItem(conditions, setConditions, c, NO_CONDITIONS, setCondInput, setCondOther)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${conditions.includes(c) ? "bg-primary text-white border-primary" : "border-gray-300 text-text-secondary hover:border-primary"}`}>
                  {c}
                </button>
              ))}
              <button type="button" onClick={() => toggleOther(conditions, setConditions, COMMON_CONDITIONS, NO_CONDITIONS, condOther, setCondOther, setCondInput)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${condOther ? "bg-primary text-white border-primary" : "border-gray-300 text-text-secondary hover:border-primary"}`}>
                Other
              </button>
            </div>
            {condOther && (
              <>
                <div className="flex gap-2">
                  <input value={condInput} onChange={(e) => setCondInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom(condInput, conditions, setConditions, setCondInput, NO_CONDITIONS, COMMON_CONDITIONS, setCondOther))}
                    placeholder="Add custom…" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  <button type="button" onClick={() => addCustom(condInput, conditions, setConditions, setCondInput, NO_CONDITIONS, COMMON_CONDITIONS, setCondOther)} className="px-3 py-2 bg-primary text-white rounded-lg text-sm">+</button>
                </div>
                {conditions.some((x) => !COMMON_CONDITIONS.includes(x)) && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {conditions.filter((x) => !COMMON_CONDITIONS.includes(x)).map((c) => (
                      <span key={c} className="px-2 py-0.5 bg-primary-pale text-primary text-xs rounded-full flex items-center gap-1">
                        {c} <button type="button" onClick={() => setConditions(conditions.filter((x) => x !== c))} className="hover:text-red-500">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Drug Allergies</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {COMMON_ALLERGIES.map((a) => (
                <button type="button" key={a} onClick={() => toggleItem(allergies, setAllergies, a, NO_ALLERGIES, setAllergyInput, setAllergyOther)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${allergies.includes(a) ? "bg-alert-red text-white border-alert-red" : "border-gray-300 text-text-secondary hover:border-alert-red"}`}>
                  {a}
                </button>
              ))}
              <button type="button" onClick={() => toggleOther(allergies, setAllergies, COMMON_ALLERGIES, NO_ALLERGIES, allergyOther, setAllergyOther, setAllergyInput)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${allergyOther ? "bg-alert-red text-white border-alert-red" : "border-gray-300 text-text-secondary hover:border-alert-red"}`}>
                Other
              </button>
            </div>
            {allergyOther && (
              <>
                <div className="flex gap-2">
                  <input value={allergyInput} onChange={(e) => setAllergyInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom(allergyInput, allergies, setAllergies, setAllergyInput, NO_ALLERGIES, COMMON_ALLERGIES, setAllergyOther))}
                    placeholder="Add custom…" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  <button type="button" onClick={() => addCustom(allergyInput, allergies, setAllergies, setAllergyInput, NO_ALLERGIES, COMMON_ALLERGIES, setAllergyOther)} className="px-3 py-2 bg-primary text-white rounded-lg text-sm">+</button>
                </div>
                {allergies.some((x) => !COMMON_ALLERGIES.includes(x)) && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {allergies.filter((x) => !COMMON_ALLERGIES.includes(x)).map((a) => (
                      <span key={a} className="px-2 py-0.5 bg-primary-pale text-primary text-xs rounded-full flex items-center gap-1">
                        {a} <button type="button" onClick={() => setAllergies(allergies.filter((x) => x !== a))} className="hover:text-red-500">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Emergency Contact</label>
            <input value={emergency} onChange={(e) => setEmergency(e.target.value)} placeholder="+91 9876543210"
              className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => navigate("/", { replace: true })}
              className="flex-1 py-3 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors">Skip for now</button>
            <button type="submit" disabled={loading}
              className="flex-1 py-3 bg-primary text-white rounded-xl text-sm font-semibold hover:bg-green-dark transition-colors disabled:opacity-60">
              {loading ? "Saving…" : "Save & Continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
