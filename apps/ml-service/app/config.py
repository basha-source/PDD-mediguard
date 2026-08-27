"""Runtime configuration for the MediGuard ML service.

Every path is resolved relative to the service root so the same code works
locally, in Docker, and on a Hugging Face Space.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("MEDIGUARD_DATA_DIR", ROOT / "data"))

# Feature 1/2 — medicine name lexicon
MEDICINE_DB = Path(os.environ.get("MEDIGUARD_MEDICINE_DB", DATA_DIR / "medicines.db"))

# Feature 3 — assistant corpus + vector index
CORPUS_PATH = Path(os.environ.get("MEDIGUARD_CORPUS", DATA_DIR / "corpus.jsonl"))
INDEX_DIR = Path(os.environ.get("MEDIGUARD_INDEX_DIR", DATA_DIR / "index"))

EMBEDDING_MODEL = os.environ.get("MEDIGUARD_EMBEDDING_MODEL", "all-MiniLM-L6-v2")
TROCR_MODEL = os.environ.get("MEDIGUARD_TROCR_MODEL", "microsoft/trocr-small-handwritten")

# Retrieval
TOP_K = int(os.environ.get("MEDIGUARD_TOP_K", "4"))
MIN_SCORE = float(os.environ.get("MEDIGUARD_MIN_SCORE", "0.25"))

# OCR
OCR_LANG = os.environ.get("MEDIGUARD_OCR_LANG", "en")
MAX_WORD_CROPS = int(os.environ.get("MEDIGUARD_MAX_WORD_CROPS", "40"))

SAFETY_LINE = (
    "This is general information only — always consult a doctor or pharmacist "
    "before starting, stopping, or changing any medication."
)
