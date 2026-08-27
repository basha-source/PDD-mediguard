import { Router } from "express";
import rateLimit   from "express-rate-limit";
import { adminAuth }   from "../config/firebaseAdmin";
import { requireAuth } from "../middleware/auth";

export const authRoutes = Router();

// 10 requests per 15 min per IP for general auth queries
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many requests, please try again later." },
});

// 3 attempts per hour for password reset
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      3,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many reset attempts, please try again in an hour." },
});

// POST /api/auth/check-email
// Returns { exists: boolean } — used by forgot-password flow for better UX
authRoutes.post("/check-email", authLimiter, async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "email is required" });
    return;
  }
  try {
    await adminAuth.getUserByEmail(email.trim().toLowerCase());
    res.json({ exists: true });
  } catch (e: any) {
    if (e?.code === "auth/user-not-found") {
      res.json({ exists: false });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// POST /api/auth/revoke-tokens
// Revokes all refresh tokens for the CALLER (call on suspicious activity).
//
// This used to read `uid` from the request body with no authentication at all,
// which let any anonymous caller sign out any account whose Firebase UID they
// knew — and UIDs are not secrets: they appear in medicines.userId,
// doseLogs.userId and in the deterministic careGuardianLinks ID
// `{guardianId}_{patientId}`. (MG-SEC-002.)
//
// The identity now comes from the verified ID token, never from the body, so
// the endpoint can only ever act on the session that called it. A body `uid` is
// rejected outright rather than ignored, so a caller relying on the old shape
// gets a clear 400 instead of silently revoking their own session.
authRoutes.post("/revoke-tokens", requireAuth, resetLimiter, async (req, res) => {
  if ((req.body as { uid?: unknown })?.uid !== undefined) {
    res.status(400).json({
      error: "uid is not accepted; this endpoint only revokes the caller's own session",
    });
    return;
  }

  const uid = (req as any).uid as string;
  try {
    await adminAuth.revokeRefreshTokens(uid);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to revoke tokens" });
  }
});
