import { ENV } from "@/config/env";

export async function askMediGuardAI(question: string): Promise<string> {
  const res = await fetch(`${ENV.BACKEND_URL}/api/ai/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error("AI service unavailable");
  const data = await res.json() as { answer: string };
  return data.answer;
}
