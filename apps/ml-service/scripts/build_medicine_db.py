#!/usr/bin/env python
"""Build data/medicines.db -- the medicine-name lexicon (Feature 1 and 2).

This database is the project's key defensible artefact: it is what turns noisy
OCR output into a real medicine name, and it is what lets prescription reading
choose from a closed vocabulary instead of guessing open text.

Sources
  1. openFDA NDC directory (bulk download, ~137k products) -- brand name,
     generic name, strength, dosage form, labeler.
  2. Indian brands: data/sources/india_medicines.csv, a curated CSV of brands
     common on Indian packaging that the US NDC directory does not carry.
     Drop a larger CDSCO export at the same path and it is picked up as-is.

Usage:
    python scripts/build_medicine_db.py            # download + build
    python scripts/build_medicine_db.py --offline  # curated CSV only
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sqlite3
import sys
import unicodedata
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import DATA_DIR, MEDICINE_DB  # noqa: E402

NDC_ZIP = "https://download.open.fda.gov/drug/ndc/drug-ndc-0001-of-0001.json.zip"
INDIA_CSV = DATA_DIR / "sources" / "india_medicines.csv"

SCHEMA = """
CREATE TABLE IF NOT EXISTS medicines (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    norm_name    TEXT NOT NULL,
    generic      TEXT NOT NULL DEFAULT '',
    strength     TEXT NOT NULL DEFAULT '',
    dosage_form  TEXT NOT NULL DEFAULT '',
    category     TEXT NOT NULL DEFAULT 'other',
    manufacturer TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_medicines_norm ON medicines(norm_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_key
    ON medicines(norm_name, strength, dosage_form);
"""

_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")

# Suffixes that appear on packs but carry no identity ("Dolo 650 Tablets IP").
_TRAILING_NOISE = re.compile(
    r"\b(?:tablets?|capsules?|syrup|suspension|injections?|solution|cream|ointment|"
    r"gel|drops?|ip|bp|usp|i\.p\.|b\.p\.)\b",
    re.IGNORECASE,
)


def normalise(name: str) -> str:
    """Fold a name to its matching key: ASCII, lowercase, no punctuation."""
    text = unicodedata.normalize("NFKD", name or "")
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = _NON_ALNUM.sub(" ", text)
    return _WS.sub(" ", text).strip()


def map_category(dosage_form: str) -> str:
    """Dosage form -> the app's five-value category enum.

    Follows `mapCategory` in apps/backend/src/routes/medicines.ts with one
    deliberate difference: `inject` is tested *before* the liquid keywords.
    Most NDC injectables are labelled "INJECTION, SOLUTION", which the original
    ordering classified as `liquid` -- 1,651 rows in this database, insulin and
    every vial among them.
    """
    form = (dosage_form or "").lower()
    if "tablet" in form:
        return "tablet"
    if "capsule" in form:
        return "capsule"
    if "inject" in form:
        return "injection"
    if any(k in form for k in ("solution", "suspension", "liquid", "syrup", "elixir", "drops")):
        return "liquid"
    return "other"


def strength_of(product: dict) -> str:
    parts = [
        (ing.get("strength") or "").strip()
        for ing in product.get("active_ingredients", []) or []
    ]
    parts = [p for p in parts if p]
    return "; ".join(parts[:3])


def fetch_ndc() -> list[dict]:
    print("downloading openFDA NDC bulk export (~27MB)...", file=sys.stderr)
    response = requests.get(NDC_ZIP, timeout=300)
    response.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        name = archive.namelist()[0]
        with archive.open(name) as fh:
            payload = json.load(fh)
    results = payload.get("results", [])
    print("  %d NDC products" % len(results), file=sys.stderr)
    return results


def ndc_rows(products: list[dict]):
    for product in products:
        dosage_form = (product.get("dosage_form") or "").strip()
        generic = (product.get("generic_name") or "").strip()
        strength = strength_of(product)
        manufacturer = (product.get("labeler_name") or "").strip()
        category = map_category(dosage_form)
        # Index brand and generic separately: a pack may print either one.
        for name in {(product.get("brand_name") or "").strip(), generic}:
            norm = normalise(name)
            if len(norm) < 3:
                continue
            yield (name.strip(), norm, generic, strength, dosage_form,
                   category, manufacturer, "openfda-ndc")


def india_rows():
    if not INDIA_CSV.exists():
        print("  ! %s not found -- skipping Indian brands" % INDIA_CSV, file=sys.stderr)
        return
    with INDIA_CSV.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            name = (row.get("name") or "").strip()
            norm = normalise(name)
            if len(norm) < 3:
                continue
            dosage_form = (row.get("dosage_form") or "").strip()
            yield (name, norm, (row.get("generic") or "").strip(),
                   (row.get("strength") or "").strip(), dosage_form,
                   map_category(dosage_form), (row.get("manufacturer") or "").strip(),
                   "india-curated")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="curated CSV only, no download")
    ap.add_argument("--out", type=Path, default=MEDICINE_DB)
    args = ap.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        args.out.unlink()

    conn = sqlite3.connect(args.out)
    conn.executescript(SCHEMA)

    total = 0
    # Indian brands go in first so they win the unique-key race against any
    # identically-named US product and keep their local manufacturer.
    for batch_name, rows in (("india", india_rows()),
                             ("openfda", () if args.offline else ndc_rows(fetch_ndc()))):
        before = conn.total_changes
        conn.executemany(
            "INSERT OR IGNORE INTO medicines "
            "(name, norm_name, generic, strength, dosage_form, category, manufacturer, source) "
            "VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )
        inserted = conn.total_changes - before
        total += inserted
        print("  %-8s %6d rows" % (batch_name, inserted), file=sys.stderr)

    conn.commit()
    conn.execute("VACUUM")

    distinct = conn.execute("SELECT COUNT(DISTINCT norm_name) FROM medicines").fetchone()[0]
    by_category = conn.execute(
        "SELECT category, COUNT(*) FROM medicines GROUP BY category ORDER BY 2 DESC"
    ).fetchall()
    conn.close()

    size_mb = args.out.stat().st_size / 1024 / 1024
    print("\n%s: %d rows, %d distinct names, %.1f MB" % (args.out, total, distinct, size_mb),
          file=sys.stderr)
    for category, count in by_category:
        print("  %-10s %6d" % (category, count), file=sys.stderr)


if __name__ == "__main__":
    main()
