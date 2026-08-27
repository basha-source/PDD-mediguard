#!/usr/bin/env python
"""Ablation study -- what each design decision is actually worth.

    python scripts/ablation.py --all

  1. lexicon      raw OCR text vs lexicon-constrained matching (the core claim)
  2. retrieval    dense / lexical / hybrid sweep over the fusion weight
  3. ocr-backend  Tesseract vs PaddleOCR (needs the photo test set)
  4. trocr        trocr-small-handwritten off-the-shelf vs fine-tuned
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.evaluate import PACKS, TESTSET, pct, read_jsonl, table  # noqa: E402


# --------------------------------------------------------------------------
# 1. Raw OCR vs lexicon-constrained matching
# --------------------------------------------------------------------------
def ablate_lexicon(verbose: bool = False) -> None:
    """The project's central claim: snapping OCR output to a closed vocabulary
    of ~54k real medicine names beats returning what the recogniser emitted.

    "raw OCR" is the honest baseline a system without a lexicon would produce:
    the most name-like line on the pack, exactly as recognised.

    The comparison is swept over increasing OCR noise, because at zero noise it
    measures almost nothing: `packs.jsonl` holds *transcribed* pack text, which
    is far cleaner than any real recogniser's output, so the raw line is already
    correct and there is nothing for a lexicon to repair. The corruption model
    is the same one `evaluate.py` uses for name matching, so the noise rates are
    comparable across both tables. Replacing the transcripts with photographed
    packs makes the 0% row the only one that matters.
    """
    import random

    from app.ocr.engine import OcrLine
    from app.ocr.matcher import get_matcher
    from app.ocr.pipeline import _fallback_name
    from scripts.evaluate import corrupt

    packs = read_jsonl(PACKS)
    matcher = get_matcher()
    rows = []
    changed: list[tuple] = []

    # 35 packs is small enough that one noise draw swings a rate by several
    # points, so each rate is averaged over SEEDS independent draws.
    SEEDS = (11, 23, 37, 51, 67)
    for rate in (0.0, 0.05, 0.10, 0.20):
        raw_correct = lex_correct = 0
        draws = SEEDS if rate else (SEEDS[0],)  # no noise -> one draw is enough

        for seed in draws:
            rng = random.Random(seed)
            for pack in packs:
                texts = [corrupt(t, rate, rng) if rate else t for t in pack["lines"]]
                lines = [
                    OcrLine(text=t, confidence=0.95,
                            box=[[0, i * 60], [400, i * 60], [400, i * 60 + max(60 - i * 6, 12)],
                                 [0, i * 60 + max(60 - i * 6, 12)]])
                    for i, t in enumerate(texts)
                ]
                expected = (pack["name"] or "").lower()

                raw = _fallback_name(lines)
                match = matcher.best_of_lines([ln.text for ln in lines],
                                              heights=[ln.height for ln in lines])
                lexicon = match.name if match else raw

                raw_hit = raw.lower() == expected
                lex_hit = lexicon.lower() == expected
                raw_correct += raw_hit
                lex_correct += lex_hit
                if raw_hit != lex_hit and seed == draws[0]:
                    changed.append((rate, pack["id"], "fixed" if lex_hit else "broken",
                                    expected, raw, lexicon))

        total = len(packs) * len(draws)
        rows.append(("%.0f%%" % (rate * 100), pct(raw_correct, total), pct(lex_correct, total),
                     "%+.1f pts" % (100.0 * (lex_correct - raw_correct) / total)))

    table("Ablation 1 -- lexicon-constrained matching (n=%d packs)" % len(packs),
          rows, ("OCR noise", "raw OCR line", "lexicon-constrained (ours)", "delta"))
    if verbose and changed:
        print("\nchanged cases:")
        for rate, pack_id, kind, expected, raw, lexicon in changed:
            print("  rate=%3.0f%% %-9s %-6s want=%-22r raw=%-24r lexicon=%r"
                  % (rate * 100, pack_id, kind, expected, raw, lexicon))


# --------------------------------------------------------------------------
# 2. Retrieval fusion sweep
# --------------------------------------------------------------------------
def ablate_retrieval(verbose: bool = False) -> None:
    from app.assistant.retriever import get_index, search
    from scripts.evaluate import QUERIES

    queries = read_jsonl(QUERIES)
    index = get_index()
    by_title = {r["title"]: r["id"] for r in index.records
                if r.get("source", "").startswith("MediGuard")}
    pairs = [(q["query"], by_title[q["expected_faq"]])
             for q in queries if q["expected_faq"] in by_title]

    rows = []
    for alpha in (0.0, 0.25, 0.5, 0.75, 0.9, 1.0):
        hits = {1: 0, 3: 0, 5: 0}
        for question, want in pairs:
            ranked = [h.record["id"] for h in search(question, top_k=5, alpha=alpha)]
            for k in (1, 3, 5):
                hits[k] += want in ranked[:k]
        label = "%.2f%s" % (alpha, {0.0: " (lexical only)", 1.0: " (dense only)"}.get(alpha, ""))
        rows.append((label, pct(hits[1], len(pairs)), pct(hits[3], len(pairs)),
                     pct(hits[5], len(pairs))))

    table("Ablation 2 -- retrieval fusion weight (n=%d questions)" % len(pairs),
          rows, ("alpha (dense weight)", "Recall@1", "Recall@3", "Recall@5"))
    print("\n  Note: every target in this set is a short curated FAQ chunk, which")
    print("  favours dense retrieval. The lexical half earns its place on drug-name")
    print("  queries ('side effects of metformin'), which this set does not cover.")


# --------------------------------------------------------------------------
# 3. OCR backend
# --------------------------------------------------------------------------
def ablate_ocr_backend(verbose: bool = False) -> None:
    from app.ocr.engine import OcrUnavailable, extract_lines
    from app.ocr.matcher import get_matcher

    packs = [p for p in read_jsonl(PACKS) if p.get("image")]
    if not packs:
        print("\nAblation 3 -- OCR backend")
        print("-" * 25)
        print("  skipped: no records in data/testset/packs.jsonl carry an `image` field.")
        print("  Add photographed packs with {\"image\": \"images/xyz.jpg\", ...} to run this.")
        return

    matcher = get_matcher()
    rows = []
    for backend in ("tesseract", "paddle"):
        correct = 0
        try:
            for pack in packs:
                lines = extract_lines(str(TESTSET / pack["image"]), backend=backend)
                match = matcher.best_of_lines([ln.text for ln in lines],
                                              heights=[ln.height for ln in lines])
                correct += bool(match) and match.name.lower() == (pack["name"] or "").lower()
        except OcrUnavailable as exc:
            rows.append((backend, "unavailable: %s" % exc))
            continue
        rows.append((backend, pct(correct, len(packs))))

    table("Ablation 3 -- OCR backend (n=%d photographed packs)" % len(packs),
          rows, ("backend", "name accuracy"))


# --------------------------------------------------------------------------
# 4. TrOCR fine-tuning
# --------------------------------------------------------------------------
def ablate_trocr(verbose: bool = False) -> None:
    from app.ocr.handwriting import ablate_checkpoints

    ablate_checkpoints(verbose=verbose)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lexicon", action="store_true")
    ap.add_argument("--retrieval", action="store_true")
    ap.add_argument("--ocr-backend", action="store_true")
    ap.add_argument("--trocr", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if args.all or not any((args.lexicon, args.retrieval, args.ocr_backend, args.trocr)):
        args.lexicon = args.retrieval = args.ocr_backend = args.trocr = True

    if args.lexicon:
        ablate_lexicon(args.verbose)
    if args.retrieval:
        ablate_retrieval(args.verbose)
    if args.ocr_backend:
        ablate_ocr_backend(args.verbose)
    if args.trocr:
        ablate_trocr(args.verbose)
    print()


if __name__ == "__main__":
    main()
