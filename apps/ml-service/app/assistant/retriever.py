"""Hybrid retrieval over the assistant index (Feature 3).

Dense MiniLM similarity is fused with word-level TF-IDF similarity. Dense
retrieval understands paraphrase ("can I take it while pregnant" vs "use in
pregnancy"); lexical retrieval anchors on exact drug names and rare terms that a
384-dim vector smooths away. `ALPHA` weights the two and is exposed so the
ablation script can sweep it (alpha=1.0 is dense-only, 0.0 is lexical-only).
"""
from __future__ import annotations

import logging
import re
import threading

from app.assistant.index import Hit, Index
from app.config import MIN_SCORE, TOP_K

log = logging.getLogger(__name__)

ALPHA = 0.75  # weight on the dense score
CANDIDATES = 30  # shortlist size fed into fusion
SECTION_BONUS = 0.12  # applied when the chunk's section matches the question's intent

# Label sections are strongly typed, and a question almost always targets one of
# them. Without this, "side effects of metformin" retrieves the right *drug* but
# ranks its Overdose and Contraindications sections above Adverse Reactions,
# because all three are lexically and semantically close to the query.
SECTION_INTENTS: list[tuple[re.Pattern[str], set[str]]] = [
    (re.compile(r"\b(side.?effects?|adverse|reactions?|make me feel|tolerat)", re.I),
     {"Side effects"}),
    (re.compile(r"\b(interact|together with|combine|mix with|alcohol|grapefruit)", re.I),
     {"Interactions"}),
    (re.compile(r"\b(how much|dose|dosage|how many|how often|when.*take)", re.I),
     {"Dosage"}),
    (re.compile(r"\b(what.*(for|treat|used)|indication|help with)", re.I),
     {"Uses", "Purpose"}),
    (re.compile(r"\b(avoid|should ?n.t|contraindicat|not (safe|take)|allerg)", re.I),
     {"Do not use", "Warnings", "Stop use"}),
    (re.compile(r"\b(overdose|too (much|many)|swallow.*whole bottle)", re.I),
     {"Overdose"}),
    (re.compile(r"\b(pregnan|breast.?feed|nursing)", re.I),
     {"Pregnancy"}),
    (re.compile(r"\b(store|storage|fridge|refrigerat|temperature|keep)", re.I),
     {"Storage"}),
]


def intended_sections(question: str) -> set[str]:
    wanted: set[str] = set()
    for pattern, sections in SECTION_INTENTS:
        if pattern.search(question):
            wanted |= sections
    return wanted


_index: Index | None = None
_lock = threading.Lock()


def get_index() -> Index:
    global _index
    if _index is None:
        with _lock:
            if _index is None:
                _index = Index.load()
                log.info("assistant index loaded: %d chunks", len(_index))
    return _index


def is_ready() -> bool:
    """True when the index can be served without a cold load."""
    return _index is not None


def search(
    question: str,
    top_k: int = TOP_K,
    alpha: float = ALPHA,
    index: Index | None = None,
) -> list[Hit]:
    from app.assistant.embedder import embed

    idx = index or get_index()
    query_vector = embed([question])[0]

    dense_scores, dense_idx = idx.dense_scores(query_vector, CANDIDATES)
    dense = {int(i): float(s) for s, i in zip(dense_scores, dense_idx)}
    lexical = idx.lexical_scores(question, CANDIDATES) if alpha < 1.0 else {}

    wanted = intended_sections(question)

    hits: list[Hit] = []
    for i in set(dense) | set(lexical):
        d = dense.get(i, 0.0)
        lx = lexical.get(i, 0.0)
        record = idx.records[i]
        score = alpha * d + (1 - alpha) * lx
        if wanted and record.get("section") in wanted:
            score += SECTION_BONUS
        hits.append(Hit(score=score, dense=d, lexical=lx, record=record))
    hits.sort(key=lambda h: -h.score)

    # openFDA carries the same text across many labels (and across a drug's
    # immediate- and extended-release versions), so without this the top-k can
    # be four copies of one passage and the answer loses all its breadth.
    deduped: list[Hit] = []
    seen: set[str] = set()
    for hit in hits:
        key = re.sub(r"\W+", "", hit.record["text"][:120]).lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(hit)
        if len(deduped) >= top_k:
            break
    return deduped


def search_relevant(question: str, top_k: int = TOP_K, min_score: float = MIN_SCORE) -> list[Hit]:
    """`search` with a relevance floor, so off-topic questions return nothing
    rather than a confidently-worded irrelevant passage."""
    return [h for h in search(question, top_k=top_k) if h.score >= min_score]
