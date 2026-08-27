"""Expiry parser tests over strings taken from real medicine packaging."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ocr.expiry import extract_expiry  # noqa: E402

TODAY = date(2026, 8, 24)

# (OCR lines, expected YYYY-MM-DD or None, why this case exists)
CASES: list[tuple[list[str], str | None, str]] = [
    # --- explicit EXP labels, common Indian pack layouts ---
    (["EXP. 07/2028"], "2028-07-31", "month-only rolls to end of month"),
    (["EXP: 07/28"], "2028-07-31", "two-digit year"),
    (["EXPIRY DATE: 31/07/2028"], "2028-07-31", "full DD/MM/YYYY"),
    (["EXP JUL 2028"], "2028-07-31", "three-letter month name"),
    (["EXP JULY 2028"], "2028-07-31", "full month name"),
    (["EXP SEPT 2028"], "2028-09-30", "four-letter SEPT"),
    (["EXP.DATE 07-2028"], "2028-07-31", "hyphen separator"),
    (["Use before: 12/2027"], "2027-12-31", "Use before label"),
    (["Best Before 03 2029"], "2029-03-31", "Best before, space separator"),
    (["USE BY 15.09.2027"], "2027-09-15", "dot separator, day precision"),
    (["Valid till 06/2030"], "2030-06-30", "Valid till label"),

    # --- MFG must never be mistaken for EXP ---
    (["MFG: 08/2023", "EXP: 07/2026"], "2026-07-31", "separate MFG and EXP lines"),
    (["MFG 08/2023 EXP 07/2026"], "2026-07-31", "MFG and EXP on one line"),
    (["MFD. 08/2023  EXP. 07/2026"], "2026-07-31", "MFD spelling"),
    (["Mfg. Date: JAN 2024  Exp. Date: DEC 2027"], "2027-12-31", "month names, both labels"),
    (["MANUFACTURED 01/2024"], None, "MFG alone yields no expiry"),
    (["PKD 05/2025"], None, "packed date is not an expiry"),

    # --- unlabelled dates ---
    (["04/2029"], "2029-04-30", "single bare date is the expiry"),
    (["08/2023", "07/2026"], "2026-07-31", "two bare dates: later one wins"),
    (["MFG 08/2023", "07/2026"], "2026-07-31", "bare date after a known MFG"),
    (["MFG 08/2026", "07/2023"], None, "bare date before MFG is not an expiry"),

    # --- batch/lot noise must be ignored ---
    (["B.NO. 07/2021", "EXP 09/2028"], "2028-09-30", "batch number ignored"),
    (["LOT 122024", "EXP 09/2028"], "2028-09-30", "lot number ignored"),

    # --- other formats ---
    (["EXP 2028-07-31"], "2028-07-31", "ISO format"),
    (["EXP 072028"], "2028-07-31", "compact MMYYYY"),
    (["EXP 2028 JUL"], "2028-07-31", "year-first month name"),

    # --- nothing to find ---
    ([], None, "no lines at all"),
    (["PARACETAMOL TABLETS IP 500mg"], None, "no date on the line"),
    (["Store below 25 C"], None, "temperature is not a date"),
    (["B.NO. AB1234"], None, "alphanumeric batch only"),

    # --- realistic full-pack OCR dumps ---
    ([
        "DOLO 650",
        "PARACETAMOL TABLETS IP",
        "650 mg",
        "B.No. TE24107",
        "Mfg. Dt. 03/2024",
        "Exp. Dt. 02/2027",
        "Rs. 30.00",
    ], "2027-02-28", "full Indian strip, Feb end-of-month"),
    ([
        "AUGMENTIN 625 DUO",
        "Amoxycillin and Potassium Clavulanate Tablets IP",
        "MFG: NOV 2024",
        "EXP: OCT 2026",
        "Store in a cool dry place",
    ], "2026-10-31", "full pack with month names"),
]


def run() -> int:
    failures = []
    for lines, expected, why in CASES:
        got = extract_expiry(lines, today=TODAY)
        if got != expected:
            failures.append((why, lines, expected, got))
    for why, lines, expected, got in failures:
        print("FAIL  %-45s expected=%-12s got=%-12s  %s" % (why, expected, got, lines))
    print("\nexpiry parser: %d/%d passed" % (len(CASES) - len(failures), len(CASES)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
