"""Medicine-name matching against medicines.db (Feature 1 and 2).

Two stages, because neither technique alone is good enough:

  1. TF-IDF over character 3-5 grams retrieves a shortlist. Character n-grams are
     robust to the exact damage OCR does -- dropped letters, `rn` read as `m`,
     `0`/`O` confusion -- because a misread name still shares most of its grams
     with the true one. This is cheap enough to run against all ~54k names.
  2. RapidFuzz rescores the shortlist with edit-distance ratios, which the
     n-gram cosine approximates but does not measure directly.

The second stage is what "lexicon-constrained matching" means in this project:
the output is always an entry that exists in the database, never free text.
"""
from __future__ import annotations

import logging
import pickle
import re
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.config import INDEX_DIR, MEDICINE_DB

log = logging.getLogger(__name__)

NAME_INDEX_PATH = INDEX_DIR / "name_tfidf.pkl"

SHORTLIST = 40           # candidates handed from stage 1 to stage 2
ACCEPT_SCORE = 0.65      # below this we report no match rather than a wrong one
HEIGHT_BONUS = 0.25      # selection-only nudge toward the largest text on a pack
TFIDF_WEIGHT = 0.45      # remainder is the RapidFuzz score

_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")

# Dosage forms and pharmacopoeia marks appear on packs but not in brand names.
_NOISE_WORDS = re.compile(
    r"\b(?:tablets?|tabs?|capsules?|caps?|syrup|suspension|injections?|solution|"
    r"cream|ointment|gel|drops?|inhaler|rotacaps|sachets?|powder|granules?|"
    r"ip|bp|usp|i\s*p|b\s*p|u\s*s\s*p)\b"
)
# Lines that are never the medicine name.
_SKIP_LINE = re.compile(
    r"\b(?:mfg|mfd|exp|batch|b\.?\s*no|lot|mrp|rs\.?|store|storage|keep|"
    r"schedule|prescription|warning|dosage|directions?|manufactured|marketed|"
    r"licen[cs]e|www|http|road|street|india|pvt|ltd)\b",
    re.IGNORECASE,
)


def normalise(name: str) -> str:
    text = _NON_ALNUM.sub(" ", (name or "").lower())
    return _WS.sub(" ", text).strip()


def match_key(name: str) -> str:
    """Normalised form with dosage-form words removed, so `DOLO 650 TABLETS IP`
    and the database's `Dolo 650` reduce to the same key."""
    text = _NOISE_WORDS.sub(" ", normalise(name))
    return _WS.sub(" ", text).strip()


# Glyph pairs OCR routinely swaps on printed packaging. Folding is applied to
# both the database names and the query, so `D0LO 65O` and `Dolo 650` collapse
# to the same string instead of scoring as four character errors.
_CONFUSIONS = str.maketrans({"0": "o", "1": "l", "5": "s", "8": "b", "2": "z"})


def fold_ocr(key: str) -> str:
    return key.replace("rn", "m").translate(_CONFUSIONS)


def _row_rank(row: tuple) -> tuple:
    """Preference order when several database rows share one match key.

    Curated Indian rows first (they carry the local brand and manufacturer),
    then a name with no dosage-form suffix, then a usable category, then the
    most complete metadata, then the shortest name.
    """
    name, _generic, strength, dosage_form, category, _manufacturer, source = row
    return (
        source == "india-curated",
        normalise(name) == match_key(name),   # no "Tablets"/"IP" suffix
        category != "other",
        bool(strength) + bool(dosage_form),
        -len(name),
    )


# ---------------------------------------------------------------------------
# Lexicon exclusions
#
# openFDA is a registry of everything with an NDC code, not a formulary, so a
# fifth of it is homeopathic preparations and botanical extracts whose "drug
# name" is an ordinary English word. Left in, they turn any photograph with text
# on it into a prescription: "Rice 5 kg" on a shopping list matched RICE at 0.862
# -- a *correct* match against a row that should never have been matchable.
#
# This cannot be fixed by raising the score threshold, because the match is
# genuinely strong. The row itself has to go.
# ---------------------------------------------------------------------------

# Homeopathic potency notation ("12 [hp_X]/mL", "200 [hp_C]/1"). Unambiguous,
# and MediGuard is an adherence tool for conventional medication.
_HOMEOPATHIC = "[hp_"

# Whole names that are a single everyday word. Real drug names essentially never
# are -- they are coined ("Paracetamol", "Zerodol") or qualified ("Dolo 650").
# Only the *entire* name is tested, so "Coconut Oil Shampoo" survives while a row
# literally called "Oil" does not.
_COMMON_NOUNS = frozenset("""
rice oil water honey salt sugar milk bread butter cheese egg eggs flour
tea coffee juice lemon lime orange apple banana grape berry mango onion
garlic ginger pepper mint basil clove almond peanut walnut cashew coconut
sesame mustard turmeric cinnamon vanilla chocolate cocoa yeast starch
silver gold copper iron zinc sulphur sulfur calcium magnesium potassium
charcoal clay chalk sand stone glass wood paper cotton wool silk leather
soap shampoo lotion cream gel spray powder solution mixture drops balm
ointment paste liquid tablet capsule syrup tonic serum wash rinse foam
oxygen nitrogen carbon alcohol vinegar wine beer smoke ash dust
milkweed nettle clover thistle dandelion lavender rose jasmine
wheat corn barley oat rye bean peas potato tomato carrot cabbage
beef pork chicken fish shrimp crab oyster lobster
dog cat horse cow goat sheep bee wasp ant
sun moon rain snow wind fire earth air light dark
food drink meal snack lunch dinner breakfast
the and for with from this that here there
one two three four five six seven eight nine ten
""".split())

# Dropped before the single-word test so "The Solution" is judged on "solution".
_ARTICLES = frozenset({"the", "a", "an", "of", "and"})


def exclusion_reason(name: str, strength: str) -> str | None:
    """Why this row must not be matchable, or None to keep it."""
    if _HOMEOPATHIC in (strength or ""):
        return "homeopathic"
    words = [w for w in re.findall(r"[a-z]+", (name or "").lower()) if w not in _ARTICLES]
    if len(words) == 1 and words[0] in _COMMON_NOUNS:
        return "common-noun"
    return None

@dataclass
class Match:
    name: str
    generic: str
    strength: str
    dosage_form: str
    category: str
    manufacturer: str
    score: float
    tfidf: float
    fuzzy: float
    query: str


class NameMatcher:
    """Loaded name lexicon plus its n-gram index."""

    def __init__(self, rows: list[tuple], vectorizer, matrix):
        self.rows = rows              # (name, generic, strength, form, category, manufacturer)
        self.keys = [match_key(r[0]) for r in rows]
        self.folded = [fold_ocr(k) for k in self.keys]
        self.vectorizer = vectorizer
        self.matrix = matrix

    # -- construction ------------------------------------------------------
    @staticmethod
    def _load_rows(db_path: Path) -> list[tuple]:
        if not db_path.exists():
            raise FileNotFoundError(
                "medicine database not found at %s -- run scripts/build_medicine_db.py" % db_path
            )
        conn = sqlite3.connect(db_path)
        raw = conn.execute(
            "SELECT name, generic, strength, dosage_form, category, manufacturer, source "
            "FROM medicines"
        ).fetchall()
        conn.close()

        # Collapse to one row per match key. The NDC directory lists the same
        # drug under several names that reduce to the same key ("Ibuprofen",
        # "Ibuprofen Tablets", "Ibuprofen Tablets USP"), so without this the
        # displayed name is whichever row the database happened to return.
        best: dict[str, tuple] = {}
        dropped: dict[str, int] = {}
        for row in raw:
            key = match_key(row[0])
            if len(key) < 3:
                continue
            reason = exclusion_reason(row[0], row[2])
            if reason:
                dropped[reason] = dropped.get(reason, 0) + 1
                continue
            if key not in best or _row_rank(row) > _row_rank(best[key]):
                best[key] = row
        if dropped:
            log.info("lexicon exclusions: %s", ", ".join(
                "%s=%d" % kv for kv in sorted(dropped.items())))
        return [row[:6] for row in best.values()]

    @classmethod
    def build(cls, db_path: Path = MEDICINE_DB) -> "NameMatcher":
        from sklearn.feature_extraction.text import TfidfVectorizer

        rows = cls._load_rows(db_path)
        # The n-gram index is built over folded keys so the shortlist survives
        # glyph confusions; scoring still sees the unfolded text as well.
        keys = [fold_ocr(match_key(r[0])) for r in rows]
        vectorizer = TfidfVectorizer(
            analyzer="char_wb", ngram_range=(3, 5), min_df=1, sublinear_tf=True,
        )
        matrix = vectorizer.fit_transform(keys)
        log.info("name matcher built: %d names, %d n-gram features",
                 len(rows), len(vectorizer.vocabulary_))
        return cls(rows, vectorizer, matrix)

    def save(self, path: Path = NAME_INDEX_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as fh:
            pickle.dump({"rows": self.rows, "vectorizer": self.vectorizer,
                         "matrix": self.matrix}, fh, protocol=pickle.HIGHEST_PROTOCOL)

    @classmethod
    def load(cls, path: Path = NAME_INDEX_PATH, db_path: Path = MEDICINE_DB) -> "NameMatcher":
        """Prefer the prebuilt n-gram index; fall back to building it from the
        database so a fresh checkout still works."""
        if path.exists():
            with path.open("rb") as fh:
                blob = pickle.load(fh)
            return cls(blob["rows"], blob["vectorizer"], blob["matrix"])
        matcher = cls.build(db_path)
        try:
            matcher.save(path)
        except OSError:  # read-only filesystem on some hosts
            pass
        return matcher

    # -- querying ----------------------------------------------------------
    def __len__(self) -> int:
        return len(self.rows)

    def _to_match(self, i: int, tfidf: float, fuzzy: float, query: str) -> Match:
        name, generic, strength, form, category, manufacturer = self.rows[i]
        return Match(
            name=name, generic=generic or "", strength=strength or "",
            dosage_form=form or "", category=category or "other",
            manufacturer=manufacturer or "",
            score=TFIDF_WEIGHT * tfidf + (1 - TFIDF_WEIGHT) * fuzzy,
            tfidf=tfidf, fuzzy=fuzzy, query=query,
        )

    def candidates(self, text: str, top_k: int = 5) -> list[Match]:
        """Ranked matches for one string. Empty if the text is unusable."""
        from rapidfuzz import fuzz

        query = match_key(text)
        if len(query) < 3:
            return []
        folded_query = fold_ocr(query)

        sims = (self.matrix @ self.vectorizer.transform([folded_query]).T).toarray().reshape(-1)
        n = min(SHORTLIST, len(sims))
        shortlist = np.argpartition(-sims, n - 1)[:n]

        scored = []
        for i in shortlist:
            i = int(i)
            if sims[i] <= 0:
                continue
            # token_set_ratio ignores word order and extra words -- essential
            # for prescription lines like "Tab Dolo 650 - 1-0-1 x 5 days", but
            # on its own it also scores "ZZQQXX HERBAL MIXTURE" against
            # "SC HERBAL" at 100. Scaling it by how well the candidate is
            # contained in the query (partial_ratio) restores the separation:
            # measured on the fixture set it moves the best false match from
            # 0.679 to 0.581 while the worst true match stays at 0.751.
            key, folded_key = self.keys[i], self.folded[i]
            contained = fuzz.partial_ratio(folded_key, folded_query) / 100.0
            fuzzy = max(
                fuzz.ratio(query, key),
                fuzz.ratio(folded_query, folded_key),
                fuzz.token_set_ratio(folded_query, folded_key) * contained,
            ) / 100.0
            scored.append(self._to_match(i, float(sims[i]), fuzzy, text))

        scored.sort(key=lambda m: -m.score)
        return scored[:top_k]

    def best(self, text: str, min_score: float = ACCEPT_SCORE) -> Match | None:
        results = self.candidates(text, top_k=1)
        return results[0] if results and results[0].score >= min_score else None

    def best_of_lines(
        self,
        lines: list[str],
        heights: list[float] | None = None,
        min_score: float = ACCEPT_SCORE,
    ) -> Match | None:
        """Pick the medicine name from a whole pack's worth of OCR lines.

        Every plausible line is matched and the best score wins. When PaddleOCR
        box heights are supplied they act as a mild prior, because the brand name
        is almost always the largest text on the pack.
        """
        max_height = max(heights) if heights else 0.0
        best: Match | None = None
        best_rank = -1.0
        for idx, line in enumerate(lines):
            if not line or _SKIP_LINE.search(line):
                continue
            # Threshold on the honest score, so the height bonus can never push
            # a non-medicine line over the acceptance bar.
            match = self.best(line, min_score=min_score)
            if match is None:
                continue
            rank = match.score
            if max_height > 0 and idx < len(heights or []):
                rank += HEIGHT_BONUS * (heights[idx] / max_height)
            if rank > best_rank:
                best, best_rank = match, rank
        return best


_matcher: NameMatcher | None = None
_lock = threading.Lock()


def get_matcher() -> NameMatcher:
    global _matcher
    if _matcher is None:
        with _lock:
            if _matcher is None:
                _matcher = NameMatcher.load()
                log.info("name matcher ready: %d names", len(_matcher))
    return _matcher
