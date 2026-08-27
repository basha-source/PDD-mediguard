"""End-to-end /ocr response-shape and content tests.

OCR lines are injected so these run without the detector -- they test the
parsing, lexicon matching and JSON assembly, which is where the logic lives.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ocr.engine import OcrLine  # noqa: E402
from app.ocr.pipeline import run_ocr  # noqa: E402


def lines(*texts: str, conf: float = 0.95) -> list[OcrLine]:
    """Fake OCR output. Box heights decrease down the pack, mimicking a real
    layout where the brand name is printed largest."""
    out = []
    for i, text in enumerate(texts):
        height = max(60 - i * 6, 12)
        out.append(OcrLine(text=text, confidence=conf,
                           box=[[0, i * 60], [400, i * 60], [400, i * 60 + height], [0, i * 60 + height]]))
    return out


DOLO = lines(
    "DOLO 650",
    "PARACETAMOL TABLETS IP",
    "650 mg",
    "B.No. TE24107",
    "Mfg. Dt. 03/2024",
    "Exp. Dt. 02/2027",
    "MRP Rs. 30.00",
)

AUGMENTIN = lines(
    "AUGMENTIN 625 DUO",
    "Amoxycillin and Potassium Clavulanate Tablets IP",
    "500mg + 125mg",
    "MFG: NOV 2024",
    "EXP: OCT 2026",
)

NOISY = lines(  # same pack, with the glyph confusions OCR actually makes
    "D0L0 65O",
    "PARACETAM0L TABLETS lP",
    "65O mg",
    "Exp. Dt. 02/2027",
)

PRESCRIPTION = lines(
    "Dr. A. Kumar MBBS MD",
    "City Clinic, Hyderabad",
    "Rx",
    "Tab Dolo 650 - 1-0-1 x 5 days",
    "Tab Pan 40 - 1-0-0 before food",
    "Cap Becosules - 0-0-1",
    "Review after 5 days",
)

FAILURES: list[str] = []


def check(label: str, got, expected) -> None:
    if got != expected:
        FAILURES.append("FAIL  %-46s expected=%r got=%r" % (label, expected, got))


def check_keys(label: str, got: dict, expected_keys: set) -> None:
    if set(got.keys()) != expected_keys:
        FAILURES.append("FAIL  %-46s keys expected=%r got=%r"
                        % (label, sorted(expected_keys), sorted(got.keys())))


def run() -> int:
    # --- mode: expiry -----------------------------------------------------
    result = run_ocr("", "expiry", lines=DOLO)
    check_keys("expiry: response shape", result, {"expiry"})
    check("expiry: reads EXP not MFG", result["expiry"], "2027-02-28")

    check("expiry: none found", run_ocr("", "expiry", lines=lines("DOLO 650"))["expiry"], None)
    check("expiry: no lines at all", run_ocr("", "expiry", lines=[])["expiry"], None)

    # --- mode: packaging --------------------------------------------------
    result = run_ocr("", "packaging", lines=DOLO)
    check_keys("packaging: response shape", result, {"name", "dosage", "category", "expiryDate"})
    check("packaging: name from lexicon", result["name"], "Dolo 650")
    check("packaging: dosage", result["dosage"], "650mg")
    check("packaging: category", result["category"], "tablet")
    check("packaging: expiryDate", result["expiryDate"], "2027-02-28")

    result = run_ocr("", "packaging", lines=AUGMENTIN)
    check("packaging: combination name", result["name"], "Augmentin 625 Duo")
    check("packaging: combination dosage", result["dosage"], "500mg + 125mg")
    check("packaging: combination category", result["category"], "tablet")
    check("packaging: combination expiry", result["expiryDate"], "2026-10-31")

    result = run_ocr("", "packaging", lines=NOISY)
    check("packaging: name survives OCR noise", result["name"], "Dolo 650")
    check("packaging: expiry survives OCR noise", result["expiryDate"], "2027-02-28")

    # name is never null, even with nothing in the lexicon
    result = run_ocr("", "packaging", lines=lines("ZZQQXX HERBAL MIXTURE", "Exp 01/2030"))
    check_keys("packaging: unknown pack shape", result,
               {"name", "dosage", "category", "expiryDate"})
    check("packaging: falls back to printed text", result["name"], "ZZQQXX HERBAL MIXTURE")
    check("packaging: unknown category", result["category"], "other")

    result = run_ocr("", "packaging", lines=[])
    check("packaging: empty name is a string", result["name"], "")
    check("packaging: empty category", result["category"], "other")

    # --- mode: prescription ----------------------------------------------
    result = run_ocr("", "prescription", lines=PRESCRIPTION)
    check_keys("prescription: response shape", result, {"medicines"})
    names = [m["name"] for m in result["medicines"]]
    for expected in ("Dolo 650", "Pan 40", "Becosules"):
        if expected not in names:
            FAILURES.append("FAIL  prescription: missing %-20s got=%r" % (expected, names))
    for med in result["medicines"]:
        check_keys("prescription: item shape", med, {"name", "dosage", "category"})
    if any(m["name"].startswith("Dr.") for m in result["medicines"]):
        FAILURES.append("FAIL  prescription: doctor's name treated as a medicine")

    check("prescription: empty", run_ocr("", "prescription", lines=[])["medicines"], [])

    # --- unknown mode -----------------------------------------------------
    check("unknown mode is safe", run_ocr("", "bogus", lines=DOLO), {"medicines": []})

    total = 30
    for failure in FAILURES:
        print(failure)
    print("\npipeline: %d checks, %d failed" % (total, len(FAILURES)))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(run())
