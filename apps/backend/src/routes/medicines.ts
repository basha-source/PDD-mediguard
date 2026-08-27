import { Router } from "express";
import axios from "axios";
import { API } from "@mediguard/shared";
import * as ml from "../services/mlService";

export const medicineRoutes = Router();

function mapCategory(dosageForm: string): string {
  if (dosageForm.includes("tablet"))   return "tablet";
  if (dosageForm.includes("capsule"))  return "capsule";
  if (dosageForm.includes("solution") || dosageForm.includes("suspension") ||
      dosageForm.includes("liquid")   || dosageForm.includes("syrup"))      return "liquid";
  if (dosageForm.includes("inject"))   return "injection";
  return "other";
}

async function fdaLookup(searchParam: string): Promise<any[] | null> {
  try {
    const url = `${API.OPENFDA_BASE}/label.json?search=${searchParam}&limit=1`;
    const { data } = await axios.get(url, { timeout: 8000 });
    return data.results?.length ? data.results : null;
  } catch {
    return null;
  }
}

async function upcitemdbLookup(barcode: string): Promise<{ name: string; category: string } | null> {
  try {
    const { data } = await axios.get(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`,
      { timeout: 6000 }
    );
    const item = data.items?.[0];
    if (!item) return null;
    const title    = item.title ?? item.brand ?? "";
    const category = item.category?.toLowerCase() ?? "";
    return {
      name:     title || "Unknown Medicine",
      category: mapCategory(category),
    };
  } catch {
    return null;
  }
}

medicineRoutes.get("/lookup", async (req, res) => {
  const { barcode } = req.query as { barcode?: string };
  if (!barcode) { res.status(400).json({ error: "barcode required" }); return; }

  // 1. Try OpenFDA (US medicines)
  let results = await fdaLookup(`openfda.upc:"${barcode}"`);
  if (!results) results = await fdaLookup(`openfda.ean_pc:"${barcode}"`);

  if (results) {
    const r = results[0];
    const name       = r.openfda?.brand_name?.[0] ?? r.openfda?.generic_name?.[0] ?? "Unknown Medicine";
    const dosage     = r.openfda?.strength?.[0] ?? "";
    const dosageForm = r.openfda?.dosage_form?.[0]?.toLowerCase() ?? "";
    res.json({ name, dosage, category: mapCategory(dosageForm), source: "openfda" });
    return;
  }

  // 2. Fallback: UPCitemdb (global coverage including Indian products)
  const upc = await upcitemdbLookup(barcode);
  if (upc) {
    res.json({ name: upc.name, dosage: "", category: upc.category, source: "upcitemdb" });
    return;
  }

  res.status(404).json({ error: "Medicine not found for this barcode" });
});

// ---------------------------------------------------------------------------
// Failure classification.
//
// Every /ocr failure used to come back as one sentence -- "Scanning service is
// busy" -- whatever had actually gone wrong. A dependency missing on the ML
// service, a container that never woke, and a genuine overload all read the
// same, so the only way to tell them apart was to open the server logs. Worse,
// "busy" actively misleads: it says retrying will help, when a missing
// dependency will fail identically forever.
//
// The app switches on `code` to pick its wording; `detail` is debugging
// material and is never shown to a patient. Mirrors routes/ai.ts.
// ---------------------------------------------------------------------------
type OcrFailure = "ocr_unavailable" | "unreachable" | "timeout" | "unknown";

function classify(err: any): OcrFailure {
  const status = err?.response?.status;
  const upstream = String(err?.response?.data?.error ?? "");

  // The ML service raises OcrUnavailable when no OCR backend can be loaded
  // (paddleocr/pytesseract absent). Retrying cannot fix that -- say so.
  if (upstream.includes("OcrUnavailable")) return "ocr_unavailable";

  // No response object at all means we never reached the service.
  if (!err?.response) {
    return err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT"
      ? "timeout"
      : "unreachable";
  }

  // A gateway fronts the Space: 502/504 means it is up but the service is not.
  if (status === 502 || status === 504) return "unreachable";

  return "unknown";
}

medicineRoutes.post("/ocr", async (req, res) => {
  const { image, mode } = req.body as {
    image?: string;
    mode?: "expiry" | "prescription" | "packaging";
  };
  if (!image || !mode) { res.status(400).json({ error: "image and mode required" }); return; }

  try {
    // Our own OCR pipeline (PaddleOCR + expiry/dosage parsers + lexicon
    // matching against medicines.db). The ML service returns exactly the JSON
    // shape this endpoint has always returned, so it is forwarded unchanged.
    const result = await ml.ocr(image, mode);
    res.json(result);
  } catch (err: any) {
    const code = classify(err);
    const detail = err?.response?.data?.error ?? err?.message ?? "unknown";
    console.error(`[OCR] mode=${mode} failed (${code}):`, detail);
    res.status(503).json({ error: "OCR failed", code, detail });
  }
});
