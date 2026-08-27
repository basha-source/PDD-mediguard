import "./config/env";           // validates env vars first — throws if missing
import "./config/firebaseAdmin"; // initialises Firebase Admin SDK
import express from "express";
import cors    from "cors";

import { medicineRoutes }     from "./routes/medicines";
import { interactionRoutes }  from "./routes/interactions";
import { aiRoutes }           from "./routes/ai";
import { notificationRoutes } from "./routes/notifications";
import { authRoutes }         from "./routes/auth";
import { ENV }                from "./config/env";
import { startMissedDoseScanner } from "./services/missedDoseService";

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "15mb" }));

app.use("/api/auth",          authRoutes);
app.use("/api/medicines",     medicineRoutes);
app.use("/api/interactions",  interactionRoutes);
app.use("/api/ai",            aiRoutes);
app.use("/api/notifications", notificationRoutes);

app.get("/", (_req, res) => res.json({
  status: "ok",
  app: "MediGuard API",
  message: "API is running. See /health and /api/* endpoints.",
}));

app.get("/health", (_req, res) => res.json({ status: "ok", app: "MediGuard API" }));

app.listen(ENV.PORT, () => {
  console.log(`MediGuard API running on port ${ENV.PORT}`);
  // Started from inside listen() so merely importing this module (tests, tooling)
  // never spins up a timer that hits Firestore every minute.
  if (ENV.MISSED_DOSE_SCAN_ENABLED) startMissedDoseScanner();
});
