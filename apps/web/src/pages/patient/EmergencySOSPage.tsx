import { withoutHealthSentinels } from "@mediguard/shared";
import { useAuthStore } from "@/store/authStore";

export function EmergencySOSPage() {
  const { user } = useAuthStore();

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-text-primary mb-2">Emergency SOS</h1>
      <p className="text-text-secondary text-sm mb-6">Quick access to emergency contacts and critical health information.</p>

      {/* Emergency contact */}
      <div className="bg-red-50 border-2 border-alert-red rounded-2xl p-6 mb-5">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-3xl">🆘</span>
          <h2 className="font-bold text-xl text-alert-red">Emergency Contact</h2>
        </div>
        {user?.emergencyContact ? (
          <div>
            <p className="text-lg font-bold text-text-primary mb-3">{user.emergencyContact}</p>
            <a href={`tel:${user.emergencyContact.replace(/\s/g, "")}`}
              className="inline-block px-6 py-3 bg-alert-red text-white rounded-xl font-semibold hover:bg-red-700 transition-colors">
              📞 Call Now
            </a>
          </div>
        ) : (
          <div>
            <p className="text-text-secondary text-sm mb-3">No emergency contact set.</p>
            <p className="text-xs text-text-secondary">Go to Profile or Health Profile to add an emergency contact.</p>
          </div>
        )}
      </div>

      {/* Health summary */}
      <div className="bg-card rounded-2xl shadow-sm border border-gray-100 p-5 mb-4">
        <h2 className="font-bold text-text-primary mb-3">Critical Health Info</h2>
        <div className="space-y-2 text-sm">
          {[
            ["Blood Group",  user?.bloodGroup ?? "Not set"],
            // "None"/"Normal" are the form's "nothing to declare" sentinels —
            // a responder must not read them as a recorded allergy/condition.
            ["Allergies",    withoutHealthSentinels(user?.allergies).join(", ") || "None recorded"],
            ["Conditions",   withoutHealthSentinels(user?.conditions).join(", ") || "None recorded"],
          ].map(([label, val]) => (
            <div key={label} className="flex justify-between py-2 border-b border-gray-50 last:border-0">
              <span className="text-text-secondary font-medium">{label}</span>
              <span className="text-text-primary text-right max-w-xs">{val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Emergency numbers */}
      <div className="bg-card rounded-2xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-bold text-text-primary mb-3">Emergency Numbers (India)</h2>
        <div className="grid grid-cols-2 gap-3">
          {[["🚑 Ambulance", "108"], ["🚒 Fire", "101"], ["👮 Police", "100"], ["🏥 National Emergency", "112"]].map(([label, num]) => (
            <a key={num} href={`tel:${num}`}
              className="flex items-center gap-3 p-3 border border-gray-200 rounded-xl hover:border-alert-red hover:bg-red-50 transition-colors">
              <span className="text-xl">{(label as string).split(" ")[0]}</span>
              <div>
                <p className="font-semibold text-text-primary">{num}</p>
                <p className="text-xs text-text-secondary">{(label as string).split(" ").slice(1).join(" ")}</p>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
