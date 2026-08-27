import { useState, useRef, useEffect } from "react";
import { askMediGuardAI } from "@/services/assistant";
import { useAuthStore } from "@/store/authStore";

type Message = { role: "user" | "assistant"; text: string; ts: number };

export function AIAssistantPage() {
  const { user }              = useAuthStore();
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: `Hi ${user?.name?.split(" ")[0] ?? "there"}! 👋 I'm your MediGuard AI assistant. Ask me anything about your medicines, dosage, side effects, or interactions.`, ts: Date.now() },
  ]);
  const [input, setInput]   = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef             = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q, ts: Date.now() }]);
    setLoading(true);
    try {
      const answer = await askMediGuardAI(q);
      setMessages((m) => [...m, { role: "assistant", text: answer, ts: Date.now() }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "Sorry, I couldn't process your request. Please check your connection and try again.", ts: Date.now() }]);
    } finally {
      setLoading(false);
    }
  }

  const SUGGESTIONS = ["What are the side effects of Metformin?", "Can I take Aspirin with Warfarin?", "What is the max daily dose of Paracetamol?"];

  return (
    <div className="flex flex-col h-screen max-h-screen p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-text-primary mb-4 shrink-0">AI Assistant 🤖</h1>

      {/* Chat window */}
      <div className="flex-1 overflow-y-auto bg-card rounded-2xl shadow-sm border border-gray-100 p-4 mb-4 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
              m.role === "user"
                ? "bg-primary text-white rounded-br-md"
                : "bg-primary-pale text-text-primary rounded-bl-md"
            }`}>
              {m.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-primary-pale text-text-secondary px-4 py-3 rounded-2xl rounded-bl-md text-sm">
              <span className="animate-pulse">Thinking…</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Suggestions */}
      {messages.length <= 1 && (
        <div className="flex gap-2 mb-3 flex-wrap shrink-0">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => setInput(s)}
              className="px-3 py-1.5 text-xs border border-primary/30 text-primary rounded-full hover:bg-primary-pale transition-colors">
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSend} className="flex gap-3 shrink-0">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about medicines, side effects, interactions…"
          className="flex-1 px-4 py-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
        <button type="submit" disabled={loading || !input.trim()}
          className="px-5 py-3 bg-primary text-white rounded-xl text-sm font-semibold hover:bg-green-dark transition-colors disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  );
}
