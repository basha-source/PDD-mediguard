import { Router } from "express";
import * as ml from "../services/mlService";

export const aiRoutes = Router();

// ---------------------------------------------------------------------------
// Failure classification.
//
// The app cannot show a patient a raw axios error, and it cannot reliably parse
// `detail` either — that is a plain string for a transport failure but the
// upstream JSON body for an HTTP error. So every failure is reduced here to one
// of a small, stable set of codes the client switches on to pick its wording.
// `detail` is still sent, but only as debugging material.
// ---------------------------------------------------------------------------
type AskFailure = "warming_up" | "index_missing" | "unreachable" | "timeout" | "unknown";

function classify(err: any): AskFailure {
  const status = err?.response?.status;
  const upstream = String(err?.response?.data?.error ?? "");

  // The ML service uses 503 for the two states it reports about itself:
  // "assistant index not built" and "assistant is still warming up".
  if (status === 503) {
    if (upstream.includes("index"))   return "index_missing";
    if (upstream.includes("warming")) return "warming_up";
  }

  // No response object at all means we never reached the service: it is not
  // listening (ECONNREFUSED), the container never woke, or we gave up waiting.
  if (!err?.response) {
    return err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT"
      ? "timeout"
      : "unreachable";
  }

  // A gateway sits in front of the Space, so 502/504 means the gateway is up
  // but the service behind it is not.
  if (status === 502 || status === 504) return "unreachable";

  return "unknown";
}

aiRoutes.post("/ask", async (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question) { res.status(400).json({ error: "question required" }); return; }

  try {
    // Retrieval-augmented answer from our own corpus. The success body must
    // stay exactly { answer: string } — the app reads that field directly.
    const { answer } = await ml.ask(question);
    res.json({ answer });
  } catch (err: any) {
    const code = classify(err);
    const detail = err?.response?.data ?? err?.message ?? "unknown";
    console.error(`[AI] /ask failed (${code}):`, JSON.stringify(detail));
    res.status(500).json({ error: "AI service temporarily unavailable", code, detail });
  }
});
