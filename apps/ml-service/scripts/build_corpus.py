#!/usr/bin/env python
"""Build the assistant's retrieval corpus (Feature 3).

Sources
  1. openFDA drug labels  -- indications, warnings, interactions, side effects.
  2. MedlinePlus health topics (NLM wsearch API) -- plain-language summaries.
  3. A curated FAQ set     -- app-specific medication-safety questions.

Output: data/corpus.jsonl, one chunk per line:
    {"id", "text", "source", "title", "url", "section"}

Usage:
    python scripts/build_corpus.py --labels 1200
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import CORPUS_PATH, DATA_DIR  # noqa: E402

OPENFDA_LABEL = "https://api.fda.gov/drug/label.json"
MEDLINEPLUS = "https://wsearch.nlm.nih.gov/ws/query"

# openFDA label field -> human-readable section name we cite in answers.
LABEL_SECTIONS = {
    "indications_and_usage": "Uses",
    "dosage_and_administration": "Dosage",
    "warnings": "Warnings",
    "warnings_and_cautions": "Warnings",
    "adverse_reactions": "Side effects",
    "drug_interactions": "Interactions",
    "contraindications": "Do not use",
    "do_not_use": "Do not use",
    "ask_doctor": "Ask a doctor",
    "ask_doctor_or_pharmacist": "Ask a doctor",
    "stop_use": "Stop use",
    "pregnancy_or_breast_feeding": "Pregnancy",
    "storage_and_handling": "Storage",
    "purpose": "Purpose",
    "overdosage": "Overdose",
}

# Words-per-chunk ~280 gives roughly 350-400 tokens; a 60-word overlap keeps
# sentences that straddle a boundary retrievable from either side.
CHUNK_WORDS = 280
OVERLAP_WORDS = 60

_WS = re.compile(r"\s+")
_SPL = re.compile(r"(?<=[.!?])\s+")


def clean(text: str) -> str:
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("•", " ")
    return _WS.sub(" ", text).strip()


def chunk(text: str) -> list[str]:
    """Sentence-aware sliding window, so a chunk never cuts mid-sentence."""
    sentences = [s for s in _SPL.split(text) if s.strip()]
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for sent in sentences:
        n = len(sent.split())
        if cur_len + n > CHUNK_WORDS and cur:
            chunks.append(" ".join(cur))
            # carry the tail of the previous chunk forward as overlap
            tail: list[str] = []
            tail_len = 0
            for prev in reversed(cur):
                tail_len += len(prev.split())
                tail.insert(0, prev)
                if tail_len >= OVERLAP_WORDS:
                    break
            cur, cur_len = tail, tail_len
        cur.append(sent)
        cur_len += n
    if cur:
        chunks.append(" ".join(cur))
    return [c for c in chunks if len(c.split()) >= 12]


def drug_title(result: dict) -> str:
    fda = result.get("openfda", {}) or {}
    for key in ("brand_name", "generic_name", "substance_name"):
        vals = fda.get(key)
        if vals:
            return str(vals[0]).title()
    return ""


def fetch_labels(limit: int) -> list[dict]:
    """Page through openFDA labels. 100/page is the API maximum."""
    out: list[dict] = []
    skip = 0
    while len(out) < limit:
        page = min(100, limit - len(out))
        try:
            r = requests.get(
                OPENFDA_LABEL,
                params={"search": "_exists_:openfda.generic_name", "limit": page, "skip": skip},
                timeout=30,
            )
            if r.status_code == 404:  # openFDA 404s past the end of the result set
                break
            r.raise_for_status()
            results = r.json().get("results", [])
        except Exception as exc:  # noqa: BLE001 - network is best-effort
            print("  ! openFDA page skip=%d failed: %s" % (skip, exc), file=sys.stderr)
            break
        if not results:
            break
        out.extend(results)
        skip += page
        print("  openFDA: %d/%d labels" % (len(out), limit), end="\r", file=sys.stderr)
        time.sleep(0.2)  # be polite to the unauthenticated rate limit
    print(file=sys.stderr)
    return out


def label_records(results: list[dict]) -> list[dict]:
    records: list[dict] = []
    seen: set[str] = set()
    for res in results:
        title = drug_title(res)
        if not title:
            continue
        spl_id = res.get("id", "")
        url = "https://open.fda.gov/apis/drug/label/"
        for field, section in LABEL_SECTIONS.items():
            for raw in res.get(field, []) or []:
                text = clean(raw)
                if len(text.split()) < 12:
                    continue
                for i, piece in enumerate(chunk(text)):
                    key = piece[:160]
                    if key in seen:  # openFDA repeats boilerplate across labels
                        continue
                    seen.add(key)
                    records.append({
                        "id": "fda:%s:%s:%d" % (spl_id or len(records), field, i),
                        "text": piece,
                        "source": "openFDA drug label",
                        "title": title,
                        "section": section,
                        "url": url,
                    })
    return records


MEDLINE_TERMS = [
    "medicines safety", "over the counter medicines", "drug interactions",
    "medication errors", "antibiotics", "pain relievers", "blood pressure medicines",
    "diabetes medicines", "cholesterol medicines", "allergy medicines",
    "asthma medicines", "antidepressants", "sleep disorders medicines",
    "vaccines", "vitamin supplements", "generic drugs", "drug reactions",
    "expired medicines", "storing medicines", "taking medicines as prescribed",
]


def fetch_medlineplus() -> list[dict]:
    records: list[dict] = []
    for term in MEDLINE_TERMS:
        try:
            r = requests.get(
                MEDLINEPLUS,
                params={"db": "healthTopics", "term": term, "retmax": 6},
                timeout=25,
            )
            r.raise_for_status()
            root = ET.fromstring(r.text)
        except Exception as exc:  # noqa: BLE001
            print("  ! MedlinePlus %r failed: %s" % (term, exc), file=sys.stderr)
            continue
        for doc in root.iter("document"):
            url = doc.get("url", "")
            title, summary = "", ""
            for content in doc.iter("content"):
                name = content.get("name")
                value = clean("".join(content.itertext()))
                if name == "title":
                    title = value
                elif name == "FullSummary":
                    summary = value
            if not summary or len(summary.split()) < 20:
                continue
            for i, piece in enumerate(chunk(summary)):
                records.append({
                    "id": "mplus:%d:%d" % (abs(hash(url)) % (10 ** 10), i),
                    "text": piece,
                    "source": "MedlinePlus (NLM)",
                    "title": title or term.title(),
                    "section": "Overview",
                    "url": url,
                })
        time.sleep(0.2)
    return records


def faq_records() -> list[dict]:
    path = Path(__file__).resolve().parent.parent / "data" / "faq.json"
    if not path.exists():
        print("  ! data/faq.json missing -- skipping curated FAQ", file=sys.stderr)
        return []
    faqs = json.loads(path.read_text(encoding="utf-8"))
    return [
        {
            "id": "faq:%d" % i,
            "text": "%s %s" % (item["question"], item["answer"]),
            "source": "MediGuard curated FAQ",
            "title": item["question"],
            "section": item.get("topic", "General"),
            "url": "",
        }
        for i, item in enumerate(faqs)
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", type=int, default=1200, help="openFDA labels to pull")
    ap.add_argument("--skip-network", action="store_true", help="curated FAQ only")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    records: list[dict] = []

    print("[1/3] curated FAQ", file=sys.stderr)
    records += faq_records()

    if not args.skip_network:
        print("[2/3] openFDA labels", file=sys.stderr)
        records += label_records(fetch_labels(args.labels))
        print("[3/3] MedlinePlus", file=sys.stderr)
        records += fetch_medlineplus()

    with CORPUS_PATH.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    by_source: dict[str, int] = {}
    for rec in records:
        by_source[rec["source"]] = by_source.get(rec["source"], 0) + 1
    print("\nwrote %d chunks -> %s" % (len(records), CORPUS_PATH), file=sys.stderr)
    for src, n in sorted(by_source.items(), key=lambda kv: -kv[1]):
        print("  %6d  %s" % (n, src), file=sys.stderr)


if __name__ == "__main__":
    main()
