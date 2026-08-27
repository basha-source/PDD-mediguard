"""Extractive answer composition (Feature 3).

No generative model in the default path: every sentence in the answer is copied
verbatim from a retrieved passage and carries a source citation. That makes
hallucination structurally impossible, which matters more for a medication app
than fluent prose.

Two paths:
  * A high-scoring curated FAQ hit is already a well-formed answer -- return it.
  * Otherwise, select the sentences most similar to the question from the top
    passages and render them as a cited summary.
"""
from __future__ import annotations

import re

import numpy as np

from app.assistant.index import Hit
from app.config import SAFETY_LINE

_SPL = re.compile(r"(?<=[.!?])\s+")

MAX_SENTENCES = 5
MAX_SENTENCE_WORDS = 60
FAQ_DIRECT_SCORE = 0.55  # above this, a curated FAQ answer is used verbatim
FAQ_DIRECT_MARGIN = 0.06  # ...but only if it clearly leads the runner-up

NO_ANSWER = (
    "I don't have reliable information on that in my medical reference library, "
    "so I'd rather not guess. Please ask a doctor or pharmacist.\n\n" + SAFETY_LINE
)


def _sentences(text: str) -> list[str]:
    out = []
    for sentence in _SPL.split(text):
        sentence = sentence.strip()
        words = sentence.split()
        if 4 <= len(words) <= MAX_SENTENCE_WORDS:
            out.append(sentence)
    return out


def _citation(record: dict) -> str:
    title = record.get("title") or "Reference"
    section = record.get("section") or ""
    source = record.get("source") or ""
    label = "%s - %s" % (title, section) if section else title
    return "%s (%s)" % (label, source) if source else label


def _faq_answer(hit: Hit) -> str:
    """Curated FAQ chunks are stored as 'question answer'; strip the question."""
    text = hit.record["text"]
    question = hit.record.get("title", "")
    if question and text.startswith(question):
        text = text[len(question):].strip()
    return "%s\n\nSource: %s\n\n%s" % (text, hit.record.get("source", "MediGuard FAQ"), SAFETY_LINE)


def compose(question: str, hits: list[Hit]) -> str:
    """Render retrieved passages into the `{"answer": ...}` string."""
    if not hits:
        return NO_ANSWER

    # A curated FAQ is a complete, well-worded answer, so it is worth using
    # verbatim -- but only when it is unambiguously the right one. A near-tie
    # means the question straddles two FAQs ("ibuprofen with alcohol" sits
    # between the alcohol entry and the two-painkillers entry), and there the
    # blended extractive answer covers both instead of guessing one.
    top = hits[0]
    runner_up = hits[1].score if len(hits) > 1 else 0.0
    if (top.record.get("source", "").startswith("MediGuard")
            and top.score >= FAQ_DIRECT_SCORE
            and top.score - runner_up >= FAQ_DIRECT_MARGIN):
        return _faq_answer(top)

    from app.assistant.embedder import embed

    # Sentence-level extraction: passages are 300+ words, most of which does not
    # answer the question. Re-rank their sentences against the query so the
    # answer stays short and on-point.
    candidates: list[tuple[str, dict]] = []
    for hit in hits:
        # A FAQ chunk is stored as "question answer" so that the question's
        # wording helps retrieval. Strip it before extracting sentences, or the
        # question itself gets selected and the answer opens by restating it.
        text = hit.record["text"]
        title = hit.record.get("title", "")
        if hit.record.get("source", "").startswith("MediGuard") and title and text.startswith(title):
            text = text[len(title):].strip()
        for sentence in _sentences(text):
            candidates.append((sentence, hit.record))
    if not candidates:
        return NO_ANSWER

    vectors = embed([question] + [c[0] for c in candidates])
    sims = vectors[1:] @ vectors[0]

    chosen: list[tuple[str, dict]] = []
    seen: set[str] = set()
    for i in np.argsort(-sims):
        sentence, record = candidates[int(i)]
        # Punctuation-insensitive key: openFDA prints the same sentence across a
        # drug's label variants with cosmetic differences (">= 1%" vs ">=1%"),
        # and a literal-prefix key lets all of them through as separate bullets.
        key = re.sub(r"\W+", "", sentence.lower())[:100]
        if key in seen:
            continue
        seen.add(key)
        chosen.append((sentence, record))
        if len(chosen) >= MAX_SENTENCES:
            break

    body = "\n".join("- %s" % s for s, _ in chosen)

    # Cite each distinct source once, in the order it is first used.
    citations: list[str] = []
    for _, record in chosen:
        cite = _citation(record)
        if cite not in citations:
            citations.append(cite)
    sources = "\n".join("%d. %s" % (i + 1, c) for i, c in enumerate(citations))

    return "Here is what my medical reference sources say:\n\n%s\n\nSources:\n%s\n\n%s" % (
        body, sources, SAFETY_LINE,
    )


def answer_question(question: str) -> str:
    from app.assistant import domain
    from app.assistant.retriever import search_relevant

    # A bare greeting is settled before the index is touched: no embed, no
    # search. It must not reach retrieval at all, or "hello" scores below
    # MIN_SCORE and falls through to NO_ANSWER, which is the wrong reply.
    if domain.is_greeting(question):
        return domain.GREETING_REPLY

    hits = search_relevant(question)

    # Nothing retrieved. That is either an off-domain question or a real
    # medical one the corpus does not cover, and the two want different
    # replies. Only the first is handled here; NO_ANSWER still owns the
    # second, safety line and all.
    if not hits and not domain.looks_medical(question):
        return domain.OFF_DOMAIN_REPLY

    return compose(question, hits)
