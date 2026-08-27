"""Strength/dosage extraction from OCR text (Feature 1, mode `packaging`).

Rule-based for the same reason as the expiry parser: dosage strings are a closed
grammar (number + unit, optionally per-volume), so regex beats a model on both
accuracy and latency.
"""
from __future__ import annotations

import re

# Canonical spelling for each unit, keyed by its lowercased OCR form.
UNITS = {
    "mg": "mg", "mgs": "mg", "milligram": "mg", "milligrams": "mg",
    "mcg": "mcg", "ug": "mcg", "µg": "mcg", "microgram": "mcg", "micrograms": "mcg",
    "g": "g", "gm": "g", "gms": "g", "gram": "g", "grams": "g",
    "ml": "ml", "mls": "ml", "millilitre": "ml", "milliliter": "ml",
    "l": "l", "iu": "IU", "u": "IU", "units": "IU",
    "%": "%", "w/v": "% w/v", "w/w": "% w/w",
}
UNIT_RE = "|".join(sorted((re.escape(u) for u in UNITS), key=len, reverse=True))

# 500mg  |  2.5 mg  |  10 MCG  |  5 %  |  1.2g
NUM_UNIT = re.compile(r"(?<![\w.])(\d{1,5}(?:\.\d{1,3})?)\s*(%s)(?![a-z])" % UNIT_RE, re.IGNORECASE)
# 500mg/5ml  |  80 mg / ml
PER_VOLUME = re.compile(
    r"(?<![\w.])(\d{1,5}(?:\.\d{1,3})?)\s*(mg|mcg|g|iu)\s*/\s*(\d{1,4}(?:\.\d{1,2})?)?\s*(ml|l|g)(?![a-z])",
    re.IGNORECASE,
)
# Combination products. The second ingredient's *name* usually sits between the
# two strengths ("Amoxycillin 500mg + Clavulanic Acid 125mg"), so allow a short
# run of words in the middle.
_STRENGTH = r"\d[\d.]*\s*(?:mg|mcg|g|ml|iu)"
COMBINATION = re.compile(
    r"(%s)\s*(?:\+|&|\band\b)\s*(?:[A-Za-z][A-Za-z.\-]*\s+){0,4}(%s)" % (_STRENGTH, _STRENGTH),
    re.IGNORECASE,
)

# Lines that contain numbers-with-units but never a dosage.
NOISE = re.compile(
    r"\b(?:store|storage|below|above|temperature|net\s*(?:wt|weight)|rs\.?|mrp|price|"
    r"contains?\s+no|batch|b\.?\s*no|lot|tel|phone|licen[cs]e|reg\.?\s*no)\b",
    re.IGNORECASE,
)

# Pack-size counts ("10 tablets", "strip of 15") are not strengths.
PACK_SIZE = re.compile(r"\b\d{1,3}\s*(?:tab(?:let)?s?|cap(?:sule)?s?|pcs|pieces|strips?)\b", re.IGNORECASE)


def _canonical(value: str, unit: str) -> str:
    unit_key = unit.lower()
    canonical = UNITS.get(unit_key, unit_key)
    number = value.rstrip("0").rstrip(".") if "." in value else value
    return "%s%s" % (number, canonical) if canonical != "%" else "%s%%" % number


def extract_dosage(lines: list[str]) -> str:
    """Best single dosage string, e.g. `500mg`, `125mg/5ml`, or "" if none.

    Preference order: per-volume strengths (most specific), then combinations,
    then plain number+unit. Within a tier the first match in reading order wins,
    since packs print the strength directly under the medicine name.
    """
    usable = [
        re.sub(r"\s+", " ", line).strip()
        for line in lines
        if line and not NOISE.search(line)
    ]

    for line in usable:
        match = PER_VOLUME.search(line)
        if match:
            amount, unit, volume, vol_unit = match.groups()
            left = _canonical(amount, unit)
            right = "%s%s" % (volume, vol_unit.lower()) if volume else vol_unit.lower()
            return "%s/%s" % (left, right)

    for line in usable:
        match = COMBINATION.search(line)
        if match:
            parts = []
            for part in match.groups():
                inner = NUM_UNIT.search(part)
                if inner:
                    parts.append(_canonical(inner.group(1), inner.group(2)))
            if len(parts) == 2:
                return "%s + %s" % tuple(parts)

    for line in usable:
        stripped = PACK_SIZE.sub(" ", line)
        match = NUM_UNIT.search(stripped)
        if match:
            return _canonical(match.group(1), match.group(2))

    return ""
