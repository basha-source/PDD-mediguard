"""`/ocr` pipeline -- assembles OCR + parsers + lexicon into the legacy JSON.

The three response shapes here are byte-identical to what Gemini used to return,
including the quirks: `expiry` uses the key `expiry` while `packaging` uses
`expiryDate`, and `name` is never null -- if nothing matches the database we
fall back to the most name-like line actually printed on the pack.
"""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from app.ocr.dosage import extract_dosage
from app.ocr.engine import OcrLine, OcrUnavailable, decode_image, extract_lines
from app.ocr.expiry import extract_expiry
from app.ocr.matcher import get_matcher

if TYPE_CHECKING:
    import numpy as np

log = logging.getLogger(__name__)

VALID_CATEGORIES = {"tablet", "capsule", "liquid", "injection", "other"}

# Used only when the pack text never matches the database.
_FORM_HINTS = (
    ("tablet", "tablet"), ("tab.", "tablet"), ("capsule", "capsule"), ("cap.", "capsule"),
    ("syrup", "liquid"), ("suspension", "liquid"), ("solution", "liquid"), ("drops", "liquid"),
    ("oral liquid", "liquid"), ("injection", "injection"), ("vial", "injection"),
    ("ampoule", "injection"),
)

# Lines that are packaging furniture rather than a medicine name.
_NOT_A_NAME = re.compile(
    r"\b(?:mfg|mfd|exp|expiry|batch|b\.?\s*no|lot|mrp|rs\.?|store|storage|keep\s+out|"
    r"schedule\s+[a-z]|prescription|warning|caution|dosage|directions?|composition|"
    r"manufactured|marketed|licen[cs]e|www|http|net\s*(?:wt|weight)|for\s+external)\b",
    re.IGNORECASE,
)
_MOSTLY_DIGITS = re.compile(r"^[\W\d]+$")

MIN_LINE_CONFIDENCE = 0.55


def _category_from_text(lines: list[str]) -> str:
    blob = " ".join(lines).lower()
    for needle, category in _FORM_HINTS:
        if needle in blob:
            return category
    return "other"


def _fallback_name(lines: list[OcrLine]) -> str:
    """Most name-like printed line: biggest text that is not pack furniture."""
    candidates = [
        line for line in lines
        if line.text and not _NOT_A_NAME.search(line.text)
        and not _MOSTLY_DIGITS.match(line.text) and len(line.text.strip()) >= 3
    ]
    if not candidates:
        # Everything on the pack was furniture or unreadable. An empty string is
        # the honest answer; echoing back "..." would look like a real reading.
        return ""
    # Prefer the tallest text; fall back to reading order when no boxes exist.
    if any(line.height for line in candidates):
        return max(candidates, key=lambda line: line.height).text.strip()
    return candidates[0].text.strip()


def _confident(lines: list[OcrLine]) -> list[OcrLine]:
    kept = [line for line in lines if line.confidence >= MIN_LINE_CONFIDENCE]
    return kept or lines  # never discard everything


def read_expiry(lines: list[OcrLine]) -> dict:
    return {"expiry": extract_expiry([line.text for line in lines])}


def read_packaging(lines: list[OcrLine]) -> dict:
    usable = _confident(lines)
    texts = [line.text for line in usable]
    heights = [line.height for line in usable]

    match = get_matcher().best_of_lines(texts, heights=heights)
    name = match.name if match else _fallback_name(usable)

    dosage = extract_dosage(texts)
    if not dosage and match and match.strength:
        # The pack did not print a legible strength but the database knows it.
        dosage = extract_dosage([match.strength]) or match.strength

    category = match.category if match else _category_from_text(texts)
    if category not in VALID_CATEGORIES:
        category = "other"

    return {
        "name": name,
        "dosage": dosage,
        "category": category,
        "expiryDate": extract_expiry(texts),
    }


# ---------------------------------------------------------------------------
# "Is this even a prescription?"
#
# Cleaning the lexicon removed the rows that made a shopping list look medical,
# but the matcher still answers whatever it is asked. This is the second line of
# defence: a page with plenty of text and not one medical token on it is not a
# prescription, and guessing at one is worse than saying so.
#
# Deliberately generous -- dosage units, dose forms, Latin frequency codes, and
# the clinic furniture that appears on nearly every real prescription. Missing a
# genuine prescription costs the user far more than letting an odd page through
# to the matcher, which now finds nothing anyway.
# ---------------------------------------------------------------------------
_RX_SIGNAL = re.compile(
    r"\b("
    r"rx|tabs?|caps?|tablets?|capsules?|syrup|susp|suspension|inj|injection|"
    r"drops?|ointment|cream|inhaler|sachet|"
    r"mg|mcg|ml|gm|iu|units?|"
    r"od|bd|tds|qds|qid|tid|hs|sos|stat|prn|"
    r"daily|twice|thrice|morning|night|before food|after food|empty stomach|"
    r"dose|dosage|prescription|prescribed|refill|"
    r"dr|doctor|clinic|hospital|patient|diagnosis|physician|mbbs|md|reg"
    r")\b",
    re.IGNORECASE,
)

# Below this many readable lines the page is probably handwritten, where the
# printed recogniser returns almost nothing. Gating there would block the TrOCR
# path before it ever ran, so the gate only applies once there is enough printed
# text for its absence of medical language to actually mean something.
_GATE_MIN_LINES = 3


def looks_like_prescription(lines: list[OcrLine]) -> bool:
    if len(lines) < _GATE_MIN_LINES:
        return True
    return any(_RX_SIGNAL.search(line.text or "") for line in lines)

def read_prescription(lines: list[OcrLine], image: "np.ndarray | None" = None) -> dict:
    """Printed path first, then the handwritten path if it found nothing.

    Printed and pharmacy-typed prescriptions go through the same lexicon
    matching as Feature 1 and work well. When that yields no medicines -- the
    usual outcome for a handwritten sheet, where the printed-text recogniser
    returns little or nothing usable -- the image is re-read with TrOCR word
    crops (app.ocr.handwriting) and snapped to the same lexicon.
    """
    usable = _confident(lines)

    # A page full of text with no medical language on it is not a prescription.
    # Reported as a reason rather than an empty list, so the app can say what
    # actually happened instead of blaming the photo quality.
    if not looks_like_prescription(usable):
        log.info("prescription gate: no medical signal in %d lines", len(usable))
        return {"medicines": [], "reason": "not_prescription"}

    matcher = get_matcher()
    medicines: list[dict] = []
    seen: set[str] = set()
    for line in usable:
        text = line.text.strip()
        if not text or _NOT_A_NAME.search(text) or _MOSTLY_DIGITS.match(text):
            continue
        match = matcher.best(text)
        if match is None or match.name.lower() in seen:
            continue
        seen.add(match.name.lower())
        dosage = extract_dosage([text])
        if not dosage and match.strength:
            dosage = extract_dosage([match.strength]) or match.strength
        category = match.category if match.category in VALID_CATEGORIES else "other"
        medicines.append({
            "name": match.name,
            "dosage": dosage,
            "category": category,
            # How well the line matched the lexicon. A prescription carries text
            # that is not a medicine -- clinic name, registration number, the
            # patient's age -- and some of it snaps to a real product: measured
            # on a printed sheet, "Reg. No. 45231" scored 0.733 against "BP Reg"
            # and "Age: 42" scored 0.719 against "G-42", while the four genuine
            # medicines scored 0.838-0.890. Dropping everything below a cutoff
            # here would also silently drop a badly-recognised real medicine, so
            # the score is reported instead and the confirm screen leaves weak
            # rows unticked -- the user opts in rather than having to notice.
            "confidence": round(match.score, 3),
        })

    if not medicines and image is not None:
        medicines = _read_handwritten(image)

    return {"medicines": medicines}


def _read_handwritten(image: "np.ndarray") -> list[dict]:
    """Handwritten fallback. Never raises: a failure here should degrade to an
    empty list (the app's confirm/edit screen lets the user type it in), not
    turn the whole scan into an error."""
    try:
        from app.ocr.handwriting import read_handwritten
    except ImportError:
        log.warning("handwriting dependencies unavailable")
        return []

    try:
        results = read_handwritten(image)
    except Exception:  # noqa: BLE001 - optional path, must not break /ocr
        log.exception("handwritten path failed")
        return []

    medicines = []
    for result in results:
        category = result["category"] if result["category"] in VALID_CATEGORIES else "other"
        dosage = extract_dosage([result.get("raw", "")]) or \
            extract_dosage([result.get("strength", "")]) or result.get("strength", "")
        medicines.append({
            "name": result["name"],
            "dosage": dosage,
            "category": category,
            "confidence": float(result.get("confidence", 0.0)),
        })
    return medicines


def empty_result(mode: str) -> dict:
    if mode == "expiry":
        return {"expiry": None}
    if mode == "packaging":
        return {"name": "", "dosage": "", "category": "other", "expiryDate": None}
    return {"medicines": []}


def run_ocr(image: str, mode: str, lines: list[OcrLine] | None = None) -> dict:
    """Entry point for `POST /ocr`.

    `lines` lets tests and the evaluation scripts inject OCR output directly and
    exercise the parsing/matching logic without running the detector.
    """
    array = None
    if lines is None:
        try:
            # Decoded once here so the handwritten fallback can re-read the same
            # pixels without a second base64 round-trip.
            array = decode_image(image)
            lines = extract_lines(array)
        except OcrUnavailable:
            log.exception("no OCR backend available")
            raise
        except ValueError:
            log.warning("undecodable image for mode=%s", mode)
            return empty_result(mode)

    if mode == "prescription":
        # Not short-circuited on empty `lines`: a handwritten sheet is exactly
        # the case where the printed-text recogniser returns nothing.
        return read_prescription(lines, image=array)

    if not lines:
        return empty_result(mode)

    if mode == "expiry":
        return read_expiry(lines)
    if mode == "packaging":
        return read_packaging(lines)
    return empty_result(mode)
