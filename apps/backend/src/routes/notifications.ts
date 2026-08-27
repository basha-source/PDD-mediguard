import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { requireAuth } from "../middleware/auth";
import { ENV } from "../config/env";
import { sendExpoPush } from "../services/pushService";
import { scanForMissedDoses } from "../services/missedDoseService";

export const notificationRoutes = Router();

/**
 * Constant-time string compare.
 *
 * `!==` on a secret leaks its length and, on most engines, its shared prefix
 * through timing. The lengths are compared first because timingSafeEqual throws
 * on mismatched buffer lengths — that check is itself length-leaking, which is
 * acceptable here (the length of a shared machine secret is not the sensitive
 * part) and unavoidable without padding.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

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
  // Fail closed when no secret is configured. ENV.CRON_SECRET has no fallback
  // (MG-SEC-001), so an unconfigured deployment disables the manual trigger
  // entirely instead of accepting a default value published in this repo. The
  // in-process 60s scanner is unaffected — it never comes through this route.
  if (!ENV.CRON_SECRET) {
    console.warn("[notifications] scan-missed called but CRON_SECRET is not set — refusing");
    res.status(503).json({ error: "Manual scan trigger is not configured" });
    return;
  }

  const secret = req.headers["x-cron-secret"];
  if (typeof secret !== "string" || !timingSafeEqualStr(secret, ENV.CRON_SECRET)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const summary = await scanForMissedDoses();
    res.json({ success: true, ...summary });
  } catch (e: any) {
    console.error("[notifications] scan-missed failed:", e?.message ?? e);
    res.status(500).json({ error: "Scan failed" });
  }
});
