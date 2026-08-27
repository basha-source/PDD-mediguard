"""Expiry-date extraction from OCR text (Feature 1, mode `expiry`).

Deliberately deterministic -- no model. Medicine packs print dates in a small,
well-understood set of formats, and a rule system is auditable, instant, and
never hallucinates a date that is not on the box.

The hard part is not parsing the date, it is picking the *right* date: nearly
every pack prints a manufacturing date next to the expiry date, and returning
MFG instead of EXP would tell a user their medicine expired years ago. So each
date candidate is scored by the label printed nearest to it.
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date

# Label vocabulary. OCR routinely mangles these, so the patterns stay loose.
EXPIRY_LABELS = re.compile(
    r"\b(?:EXP(?:IRY|IRES|IRATION)?|EXP\.?|EX?P|USE\s*(?:BEFORE|BY)|BEST\s*BEFORE|"
    r"BB|VALID\s*(?:TILL|UNTIL|UPTO|UP\s*TO)|NOT\s*AFTER)\b\.?",
    re.IGNORECASE,
)
MFG_LABELS = re.compile(
    r"\b(?:MFG|MFD|MF?G\.?\s*DATE|MANUFACTUR(?:ED|ING)|PKD|PACKED|DOM|DATE\s*OF\s*MFG)\b\.?",
    re.IGNORECASE,
)
# Batch/lot numbers sit right beside dates and can look date-like once OCR'd.
BATCH_LABELS = re.compile(r"\b(?:B\.?\s*NO|BATCH|LOT|L\.?\s*NO)\b\.?", re.IGNORECASE)

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}
MONTH_RE = "|".join(sorted(MONTHS, key=len, reverse=True))

SEP = r"[\/\-\.\s]"

# Ordered most-specific first: the first pattern that matches a span wins.
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # 2026-07-31
    ("ymd", re.compile(r"\b(?P<y>20\d{2})%s(?P<m>0?[1-9]|1[0-2])%s(?P<d>0?[1-9]|[12]\d|3[01])\b" % (SEP, SEP))),
    # 31/07/2026 or 31-07-26
    ("dmy", re.compile(r"\b(?P<d>0?[1-9]|[12]\d|3[01])%s(?P<m>0?[1-9]|1[0-2])%s(?P<y>20\d{2}|\d{2})\b" % (SEP, SEP))),
    # JUL 2026 / JUL-26 / JULY 2026
    ("my_name", re.compile(r"\b(?P<mon>%s)[A-Z]*%s?(?P<y>20\d{2}|\d{2})\b" % (MONTH_RE, SEP), re.IGNORECASE)),
    # 2026 JUL
    ("ym_name", re.compile(r"\b(?P<y>20\d{2})%s?(?P<mon>%s)[A-Z]*\b" % (SEP, MONTH_RE), re.IGNORECASE)),
    # 07/2026 or 07-26  (month-only: normalised to the last day of the month)
    ("my", re.compile(r"\b(?P<m>0?[1-9]|1[0-2])%s(?P<y>20\d{2}|\d{2})\b" % SEP)),
    # 072026 / 0726 with no separator, e.g. laser-printed batch lines
    ("compact", re.compile(r"\b(?P<m>0[1-9]|1[0-2])(?P<y>20\d{2}|2\d)\b")),
]

# Two-digit years: packs never carry a 19xx expiry, and MFG dates run a few
# years back at most, so anything <= 79 is 20xx.
CENTURY_PIVOT = 80


@dataclass
class Candidate:
    value: date
    month_only: bool
    kind: str          # "expiry" | "mfg" | "unlabelled"
    raw: str
    line: str


def _year(raw: str) -> int:
    y = int(raw)
    if y >= 100:
        return y
    return 2000 + y if y < CENTURY_PIVOT else 1900 + y


def _month_number(name: str) -> int:
    """`JULY` / `Sept.` / `JUL` -> month number. Raises KeyError if unknown."""
    key = name.strip().rstrip(".").lower()
    return MONTHS.get(key[:4], MONTHS[key[:3]])


def _end_of_month(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


def _to_date(kind: str, groups: dict[str, str]) -> tuple[date, bool] | None:
    """Return (date, month_only) or None if the numbers are not a real date."""
    try:
        if kind == "ymd":
            return date(int(groups["y"]), int(groups["m"]), int(groups["d"])), False
        if kind == "dmy":
            return date(_year(groups["y"]), int(groups["m"]), int(groups["d"])), False
        if kind in ("my_name", "ym_name"):
            return _end_of_month(_year(groups["y"]), _month_number(groups["mon"])), True
        if kind in ("my", "compact"):
            return _end_of_month(_year(groups["y"]), int(groups["m"])), True
    except (ValueError, KeyError):
        return None
    return None


def _classify(line: str, start: int, end: int) -> str:
    """Label a date by the nearest keyword on its own line.

    A pack line is typically `MFG: 08/2023  EXP: 07/2026`, so the label that
    matters is the closest one to the *left* of the date; a label to the right
    is only used when nothing precedes it.
    """
    best_kind, best_distance = "unlabelled", 10 ** 6
    for pattern, kind in ((EXPIRY_LABELS, "expiry"), (MFG_LABELS, "mfg"), (BATCH_LABELS, "batch")):
        for match in pattern.finditer(line):
            if match.end() <= start:
                distance = start - match.end()          # label before the date
            elif match.start() >= end:
                distance = (match.start() - end) + 100  # after: heavily penalised
            else:
                continue
            if distance < best_distance and distance < 220:
                best_kind, best_distance = kind, distance
    return best_kind


def find_candidates(lines: list[str]) -> list[Candidate]:
    candidates: list[Candidate] = []
    for line in lines:
        text = re.sub(r"\s+", " ", line).strip()
        if not text:
            continue
        claimed: list[tuple[int, int]] = []
        for kind, pattern in PATTERNS:
            for match in pattern.finditer(text):
                span = match.span()
                # a more specific pattern already consumed this text
                if any(span[0] < c_end and c_start < span[1] for c_start, c_end in claimed):
                    continue
                parsed = _to_date(kind, match.groupdict())
                if parsed is None:
                    continue
                claimed.append(span)
                label = _classify(text, span[0], span[1])
                if label == "batch":
                    continue
                candidates.append(Candidate(
                    value=parsed[0], month_only=parsed[1], kind=label,
                    raw=match.group(0), line=text,
                ))
    return candidates


def extract_expiry(lines: list[str], today: date | None = None) -> str | None:
    """Best expiry date from OCR lines as `YYYY-MM-DD`, or None.

    Selection order:
      1. an explicitly EXP-labelled date (latest, if several)
      2. otherwise the latest unlabelled date that is *after* every MFG date
      3. otherwise nothing -- better to return None than to return the MFG date
    """
    today = today or date.today()
    candidates = find_candidates(lines)
    if not candidates:
        return None

    labelled = [c for c in candidates if c.kind == "expiry"]
    if labelled:
        return max(c.value for c in labelled).isoformat()

    mfg_dates = [c.value for c in candidates if c.kind == "mfg"]
    unlabelled = [c for c in candidates if c.kind == "unlabelled"]
    if mfg_dates:
        latest_mfg = max(mfg_dates)
        after_mfg = [c.value for c in unlabelled if c.value > latest_mfg]
        return max(after_mfg).isoformat() if after_mfg else None

    if unlabelled:
        # No labels at all. A shelf-dated pack prints exactly one date and it is
        # the expiry; with several, the latest is the only sane pick.
        return max(c.value for c in unlabelled).isoformat()
    return None
