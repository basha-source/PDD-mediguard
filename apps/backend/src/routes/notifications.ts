import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { ENV } from "../config/env";
import { sendExpoPush } from "../services/pushService";
import { scanForMissedDoses } from "../services/missedDoseService";

export const notificationRoutes = Router();

// POST /api/notifications/send
// Fires a single Expo push. Still behind requireAuth — an open push endpoint is
// a spam relay for anyone who can guess a token.
notificationRoutes.post("/send", requireAuth, async (req, res) => {
  const { token, title, body, data } = req.body as {
    token?: string; title?: string; body?: string; data?: Record<string, unknown>;
  };
  if (!token || !title || !body) { res.status(400).json({ error: "token, title, body required" }); return; }

  const sent = await sendExpoPush(token, title, body, data);
  // pushService never throws, so a false here means Expo rejected the token
  // (usually stale or malformed) rather than that the server broke.
  if (!sent) { res.status(502).json({ success: false, error: "Push was not accepted by Expo" }); return; }
  res.json({ success: true });
});

// POST /api/notifications/scan-missed
// Runs one missed-dose scan on demand. The in-process scheduler already ticks
// every minute; this exists for manual triggers and for an external cron if we
// ever move off a single always-on instance.
//
// It writes alerts and sends pushes, so it is NOT public: it takes a shared
// secret header instead of a Firebase token, because the caller is a machine
// with no user identity to verify.
notificationRoutes.post("/scan-missed", async (req, res) => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== ENV.CRON_SECRET) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const summary = await scanForMissedDoses();
    res.json({ success: true, ...summary });
  } catch (e: any) {
    console.error("[notifications] scan-missed failed:", e?.message ?? e);
    res.status(500).json({ error: "Scan failed" });
  }
});
