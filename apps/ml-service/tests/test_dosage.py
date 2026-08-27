"""Dosage extraction tests over strings taken from real medicine packaging."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ocr.dosage import extract_dosage  # noqa: E402

CASES: list[tuple[list[str], str, str]] = [
    (["PARACETAMOL 500mg"], "500mg", "plain mg"),
    (["Paracetamol 500 MG"], "500mg", "space + uppercase unit"),
    (["Amlodipine 2.5 mg"], "2.5mg", "decimal strength"),
    (["Levothyroxine 25 mcg"], "25mcg", "micrograms"),
    (["Vitamin D3 60000 IU"], "60000IU", "international units"),
    (["Metformin 1 g"], "1g", "grams"),
    (["Cough syrup 100 ml"], "100ml", "millilitres"),
    (["Clotrimazole cream 1%"], "1%", "percentage"),
    (["Salbutamol 5 %"], "5%", "percentage with space"),

    # per-volume beats a bare number elsewhere on the pack
    (["AMOXICILLIN ORAL SUSPENSION", "125mg/5ml"], "125mg/5ml", "suspension strength"),
    (["Paracetamol Suspension 250 mg / 5 ml"], "250mg/5ml", "spaced per-volume"),
    (["Insulin 100 IU/ml"], "100IU/ml", "per-ml without a number"),

    # combinations
    (["Amoxycillin 500mg + Clavulanic Acid 125mg"], "500mg + 125mg", "combination product"),

    # noise rejection
    (["Store below 25 C", "Paracetamol 650mg"], "650mg", "storage line skipped"),
    (["Net wt. 10 g", "Diclofenac 50mg"], "50mg", "net weight skipped"),
    (["MRP Rs. 30.00", "Cetirizine 10mg"], "10mg", "price line skipped"),
    (["B.No. 5mg123", "Azithromycin 250 mg"], "250mg", "batch line skipped"),
    (["10 Tablets", "Ibuprofen 400mg"], "400mg", "pack count is not a strength"),
    (["Strip of 15 tablets"], "", "pack count alone yields nothing"),

    # nothing to find
    ([], "", "no lines"),
    (["DOLO", "PARACETAMOL TABLETS IP"], "", "no strength printed"),

    # realistic full-pack dump
    ([
        "DOLO 650",
        "PARACETAMOL TABLETS IP",
        "650 mg",
        "10 Tablets",
        "MRP Rs. 30.00",
    ], "650mg", "full Indian strip"),
]


def run() -> int:
    failures = []
    for lines, expected, why in CASES:
        got = extract_dosage(lines)
        if got != expected:
            failures.append((why, lines, expected, got))
    for why, lines, expected, got in failures:
        print("FAIL  %-40s expected=%-16r got=%-16r  %s" % (why, expected, got, lines))
    print("\ndosage parser: %d/%d passed" % (len(CASES) - len(failures), len(CASES)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
