#!/usr/bin/env python
"""Evaluation harness -- prints every metric table in the migration plan.

    python scripts/evaluate.py --all
    python scripts/evaluate.py --ocr --names --retrieval

Metrics
  OCR field extraction   per-field accuracy (name / dosage / expiry / category)
  Name matching          top-1 and top-5 against medicines.db, under a
                         calibrated OCR corruption model
  Retrieval              Recall@1 / @3 / @5 on paraphrased questions

Test sets live in data/testset/. `packs.jsonl` currently holds transcribed pack
text; records that carry an `image` field are run through the real detector
instead, so the photo test set drops into the same file and the same command.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import DATA_DIR  # noqa: E402

TESTSET = DATA_DIR / "testset"
PACKS = TESTSET / "packs.jsonl"
QUERIES = TESTSET / "queries.jsonl"


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError("missing test set: %s" % path)
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def table(title: str, rows: list[tuple], headers: tuple) -> None:
    print("\n%s" % title)
    print("-" * len(title))
    widths = [max(len(str(h)), *(len(str(r[i])) for r in rows)) if rows else len(str(h))
              for i, h in enumerate(headers)]
    print("  ".join(str(h).ljust(w) for h, w in zip(headers, widths)))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(str(c).ljust(w) for c, w in zip(row, widths)))


def pct(n: int, d: int) -> str:
    return "%.1f%% (%d/%d)" % (100.0 * n / d, n, d) if d else "n/a"


# --------------------------------------------------------------------------
# 1. OCR field extraction
# --------------------------------------------------------------------------
def eval_ocr(verbose: bool = False) -> None:
    from app.ocr.engine import OcrLine, extract_lines
    from app.ocr.pipeline import run_ocr

    packs = read_jsonl(PACKS)
    fields = ("name", "dosage", "expiry", "category")
    correct = dict.fromkeys(fields, 0)
    all_fields_correct = 0
    misses: list[tuple] = []

    for pack in packs:
        if pack.get("image"):
            lines = extract_lines(str(TESTSET / pack["image"]))
        else:
            # Synthesise descending box heights: on a real pack the brand name
            # is the largest text, and the matcher uses that as a prior.
            lines = [
                OcrLine(text=t, confidence=0.95,
                        box=[[0, i * 60], [400, i * 60], [400, i * 60 + max(60 - i * 6, 12)],
                             [0, i * 60 + max(60 - i * 6, 12)]])
                for i, t in enumerate(pack["lines"])
            ]

        packaging = run_ocr("", "packaging", lines=lines)
        expiry_only = run_ocr("", "expiry", lines=lines)

        got = {
            "name": packaging["name"],
            "dosage": packaging["dosage"],
            "expiry": expiry_only["expiry"],
            "category": packaging["category"],
        }
        pack_clean = True
        for field in fields:
            expected = pack[field]
            # Names are compared case-insensitively: the lexicon's canonical
            # casing is not something the user ever sees as wrong.
            hit = (got[field] or "").lower() == (expected or "").lower() \
                if isinstance(expected, str) or expected is None else got[field] == expected
            if hit:
                correct[field] += 1
            else:
                pack_clean = False
                misses.append((pack["id"], field, expected, got[field], pack.get("note", "")))
        if pack_clean:
            all_fields_correct += 1

        # Cross-check: the two modes must agree on the expiry date they report.
        if packaging["expiryDate"] != expiry_only["expiry"]:
            misses.append((pack["id"], "MODE-DISAGREE", packaging["expiryDate"],
                           expiry_only["expiry"], "packaging vs expiry mode"))

    total = len(packs)
    table(
        "OCR field extraction (n=%d packs)" % total,
        [(f, pct(correct[f], total)) for f in fields]
        + [("all four fields", pct(all_fields_correct, total))],
        ("field", "accuracy"),
    )

    if verbose and misses:
        print("\nmisses:")
        for pack_id, field, expected, got, note in misses:
            print("  %-9s %-14s expected=%-22r got=%-22r %s"
                  % (pack_id, field, expected, got, note))


# --------------------------------------------------------------------------
# 2. Medicine-name matching under an OCR corruption model
# --------------------------------------------------------------------------
# Calibrated to the errors real pack OCR makes: glyph swaps dominate, then
# dropped characters, then spurious ones.
CONFUSION = {"o": "0", "0": "o", "l": "1", "1": "l", "i": "l", "s": "5", "5": "s",
             "b": "8", "8": "b", "g": "9", "m": "rn", "c": "e", "e": "c", "n": "h"}


def corrupt(name: str, rate: float, rng: random.Random) -> str:
    out = []
    for ch in name:
        roll = rng.random()
        if roll < rate * 0.6 and ch.lower() in CONFUSION:
            out.append(CONFUSION[ch.lower()])
        elif roll < rate * 0.8:
            continue                                   # dropped character
        elif roll < rate:
            out.append(ch)
            out.append(rng.choice("abcdefghijklmnopqrstuvwxyz"))  # spurious character
        else:
            out.append(ch)
    return "".join(out)


def eval_names(sample: int = 500, seed: int = 7, verbose: bool = False) -> None:
    from app.ocr.matcher import get_matcher

    matcher = get_matcher()
    rng = random.Random(seed)
    names = [row[0] for row in matcher.rows if len(row[0]) >= 4]
    picked = rng.sample(names, min(sample, len(names)))

    rows = []
    for rate in (0.0, 0.05, 0.10, 0.20):
        top1 = top5 = 0
        examples = []
        for name in picked:
            query = corrupt(name, rate, rng) if rate else name
            results = matcher.candidates(query, top_k=5)
            ranked = [r.name.lower() for r in results]
            if ranked and ranked[0] == name.lower():
                top1 += 1
            elif verbose and len(examples) < 3:
                examples.append((query, name, ranked[0] if ranked else "-"))
            if name.lower() in ranked:
                top5 += 1
        rows.append(("%.0f%%" % (rate * 100), pct(top1, len(picked)), pct(top5, len(picked))))
        if verbose and examples:
            for query, want, got in examples:
                print("    rate=%.0f%%  %-28r want=%-24r got=%r" % (rate * 100, query, want, got))

    table("Medicine-name matching (n=%d names sampled from medicines.db)" % len(picked),
          rows, ("corruption rate", "top-1", "top-5"))


# --------------------------------------------------------------------------
# 3. Retrieval quality
# --------------------------------------------------------------------------
def eval_retrieval(verbose: bool = False) -> None:
    from app.assistant.retriever import ALPHA, get_index, search

    queries = read_jsonl(QUERIES)
    index = get_index()
    # Resolve each expected FAQ question to the corpus chunk that carries it.
    by_title = {r["title"]: r["id"] for r in index.records
                if r.get("source", "").startswith("MediGuard")}

    missing = [q["expected_faq"] for q in queries if q["expected_faq"] not in by_title]
    if missing:
        print("WARNING: %d expected FAQs are not in the corpus, e.g. %r"
              % (len(missing), missing[0]))

    rows = []
    for label, alpha in (("hybrid (alpha=%.2f)" % ALPHA, ALPHA),
                         ("dense only", 1.0), ("lexical only", 0.0)):
        hits = {1: 0, 3: 0, 5: 0}
        failures = []
        for query in queries:
            want = by_title.get(query["expected_faq"])
            if want is None:
                continue
            ranked = [h.record["id"] for h in search(query["query"], top_k=5, alpha=alpha)]
            for k in (1, 3, 5):
                if want in ranked[:k]:
                    hits[k] += 1
            if verbose and want not in ranked[:5] and len(failures) < 3:
                failures.append(query["query"])
        n = len(queries) - len(missing)
        rows.append((label, pct(hits[1], n), pct(hits[3], n), pct(hits[5], n)))
        if verbose and failures:
            for f in failures:
                print("    %-22s missed: %r" % (label, f))

    table("Retrieval Recall@k (n=%d paraphrased questions)" % (len(queries) - len(missing)),
          rows, ("configuration", "Recall@1", "Recall@3", "Recall@5"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocr", action="store_true")
    ap.add_argument("--names", action="store_true")
    ap.add_argument("--retrieval", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--sample", type=int, default=500, help="names sampled for name matching")
    ap.add_argument("-v", "--verbose", action="store_true", help="show individual failures")
    args = ap.parse_args()

    if args.all or not (args.ocr or args.names or args.retrieval):
        args.ocr = args.names = args.retrieval = True

    if args.ocr:
        eval_ocr(args.verbose)
    if args.names:
        eval_names(args.sample, verbose=args.verbose)
    if args.retrieval:
        eval_retrieval(args.verbose)
    print()


if __name__ == "__main__":
    main()
