"""Handwritten prescription reading (Feature 2).

Pipeline: detect word boxes -> recognise each crop with TrOCR -> snap the noisy
string to the nearest entry in medicines.db.

The snapping step is the important one. Open-vocabulary handwriting recognition
on doctors' handwriting is genuinely hard, and a fine-tuned `trocr-small` will
still emit strings like "Amoxycilin 5OOmg". But the space of *valid* answers is
not open: it is the ~54k names already in our lexicon. Constraining the output
to that set converts many near-misses into exact hits, and it is measured in
`scripts/ablation.py` (ablation 1) rather than asserted.

Two things this module deliberately does not do:
  * It never returns a medicine the lexicon does not contain.
  * It never returns a low-confidence reading silently -- every result carries a
    confidence, and the app shows a confirm/edit screen before anything is saved.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

import numpy as np

from app.config import MAX_WORD_CROPS, TROCR_MODEL

log = logging.getLogger(__name__)

# TrOCR on CPU costs roughly 0.3-0.8s per crop, so a prescription with 60 word
# boxes would blow any sane request budget. Crops are ranked by area and capped.
MIN_CROP_PIXELS = 12
SNAP_MIN_SCORE = 0.60


@dataclass
class WordCrop:
    image: np.ndarray
    box: list[list[float]]
    top: float
    left: float


_model = None
_processor = None
_lock = threading.Lock()


def _load():
    """Load TrOCR once. `MEDIGUARD_TROCR_MODEL` may point at a local fine-tuned
    checkpoint directory instead of the Hugging Face id."""
    global _model, _processor
    if _model is None:
        with _lock:
            if _model is None:
                import torch
                from transformers import TrOCRProcessor, VisionEncoderDecoderModel

                log.info("loading TrOCR %s", TROCR_MODEL)
                _processor = TrOCRProcessor.from_pretrained(TROCR_MODEL)
                model = VisionEncoderDecoderModel.from_pretrained(TROCR_MODEL)
                model.eval()
                torch.set_num_threads(max(1, (torch.get_num_threads() or 2)))
                _model = model
    return _model, _processor


def detect_word_crops(image: np.ndarray, max_crops: int = MAX_WORD_CROPS) -> list[WordCrop]:
    """Use PaddleOCR's detector (no recognition) to find word boxes."""
    from app.ocr.engine import _get_paddle

    result = _get_paddle().ocr(image, det=True, rec=False, cls=False)
    boxes = []
    for page in result or []:
        for box in page or []:
            boxes.append(box)

    crops: list[WordCrop] = []
    height, width = image.shape[:2]
    for box in boxes:
        xs = [int(round(p[0])) for p in box]
        ys = [int(round(p[1])) for p in box]
        left, right = max(0, min(xs)), min(width, max(xs))
        top, bottom = max(0, min(ys)), min(height, max(ys))
        if right - left < MIN_CROP_PIXELS or bottom - top < MIN_CROP_PIXELS:
            continue
        crops.append(WordCrop(image=image[top:bottom, left:right], box=box,
                              top=float(top), left=float(left)))

    # Largest text first: drug names are written larger than the dosing schedule,
    # so when the cap bites it drops the least important crops.
    crops.sort(key=lambda c: -(c.image.shape[0] * c.image.shape[1]))
    return crops[:max_crops]


def recognise(crops: list[WordCrop], batch_size: int = 8) -> list[str]:
    """Run TrOCR over word crops, returning one string per crop."""
    if not crops:
        return []
    import torch
    from PIL import Image

    model, processor = _load()
    texts: list[str] = []
    for start in range(0, len(crops), batch_size):
        batch = crops[start:start + batch_size]
        images = [Image.fromarray(c.image).convert("RGB") for c in batch]
        pixel_values = processor(images=images, return_tensors="pt").pixel_values
        with torch.no_grad():
            ids = model.generate(pixel_values, max_new_tokens=24)
        texts.extend(processor.batch_decode(ids, skip_special_tokens=True))
    return [t.strip() for t in texts]


def snap_to_lexicon(texts: list[str], min_score: float = SNAP_MIN_SCORE) -> list[dict]:
    """Constrain recognised strings to real medicine names.

    Adjacent crops are also tried as a pair, because a two-word brand name
    ("Zerodol SP", "Augmentin 625 Duo") is detected as two separate boxes.
    """
    from app.ocr.matcher import get_matcher

    matcher = get_matcher()
    candidates: list[str] = []
    for i, text in enumerate(texts):
        if len(text) >= 3:
            candidates.append(text)
        if i + 1 < len(texts):
            candidates.append("%s %s" % (text, texts[i + 1]))

    results: list[dict] = []
    seen: set[str] = set()
    for candidate in candidates:
        match = matcher.best(candidate, min_score=min_score)
        if match is None or match.name.lower() in seen:
            continue
        seen.add(match.name.lower())
        results.append({
            "name": match.name,
            "category": match.category,
            "strength": match.strength,
            "confidence": round(match.score, 3),
            "raw": candidate,
        })
    results.sort(key=lambda r: -r["confidence"])
    return results


def read_handwritten(image: np.ndarray) -> list[dict]:
    """Full handwritten path: crops -> TrOCR -> lexicon snapping."""
    crops = detect_word_crops(image)
    if not crops:
        return []
    # Restore reading order before snapping, so adjacent-pair merging sees words
    # that were actually next to each other on the page.
    crops.sort(key=lambda c: (round(c.top / 20), c.left))
    return snap_to_lexicon(recognise(crops))


# ---------------------------------------------------------------------------
# Evaluation: character error rate
# ---------------------------------------------------------------------------
def cer(reference: str, hypothesis: str) -> float:
    """Character error rate = Levenshtein(ref, hyp) / len(ref)."""
    from rapidfuzz.distance import Levenshtein

    reference = (reference or "").strip()
    if not reference:
        return 0.0 if not (hypothesis or "").strip() else 1.0
    return Levenshtein.distance(reference, hypothesis or "") / len(reference)


def ablate_checkpoints(verbose: bool = False) -> None:
    """Ablation 4: off-the-shelf vs fine-tuned TrOCR, by CER and by end-to-end
    name accuracy after lexicon snapping.

    Needs a labelled crop set at data/testset/handwriting/ (see the README) and,
    for the second arm, a checkpoint produced by notebooks/trocr_finetune.ipynb.
    """
    import json
    import os
    from pathlib import Path

    from app.config import DATA_DIR
    from scripts.evaluate import pct, table

    crop_dir = DATA_DIR / "testset" / "handwriting"
    labels_path = crop_dir / "labels.jsonl"
    if not labels_path.exists():
        print("\nAblation 4 -- TrOCR fine-tuning")
        print("-" * 31)
        print("  skipped: no labelled crops at %s" % labels_path)
        print("  Produce them with notebooks/trocr_finetune.ipynb (it exports the")
        print("  held-out split), then re-run.")
        return

    from PIL import Image

    with labels_path.open(encoding="utf-8") as fh:
        samples = [json.loads(line) for line in fh if line.strip()]

    finetuned = os.environ.get("MEDIGUARD_TROCR_FINETUNED", str(DATA_DIR / "trocr-finetuned"))
    arms = [("off-the-shelf (%s)" % TROCR_MODEL, TROCR_MODEL)]
    if Path(finetuned).exists():
        arms.append(("fine-tuned", finetuned))
    else:
        print("\n  note: no fine-tuned checkpoint at %s -- reporting baseline only" % finetuned)

    rows = []
    for label, checkpoint in arms:
        global _model, _processor
        with _lock:
            _model = _processor = None
        os.environ["MEDIGUARD_TROCR_MODEL"] = checkpoint
        import app.config as config
        config.TROCR_MODEL = checkpoint

        total_cer, snapped_correct = 0.0, 0
        for sample in samples:
            image = np.array(Image.open(crop_dir / sample["image"]).convert("RGB"))
            hypothesis = recognise([WordCrop(image=image, box=[], top=0, left=0)])[0]
            total_cer += cer(sample["text"], hypothesis)
            snapped = snap_to_lexicon([hypothesis])
            snapped_correct += bool(snapped) and \
                snapped[0]["name"].lower() == sample["text"].lower()
            if verbose:
                print("    %-28r -> %-28r" % (sample["text"], hypothesis))
        rows.append((label, "%.3f" % (total_cer / len(samples)),
                     pct(snapped_correct, len(samples))))

    table("Ablation 4 -- TrOCR fine-tuning (n=%d crops)" % len(samples),
          rows, ("checkpoint", "CER", "name accuracy after snapping"))
