"""MiniLM sentence embeddings (Feature 3).

`all-MiniLM-L6-v2` is 90MB and runs comfortably on the free CPU tier. The model
is loaded lazily and cached so the FastAPI process boots instantly and only pays
the load cost on the first `/ask`.
"""
from __future__ import annotations

import logging
import threading

import numpy as np

from app.config import EMBEDDING_MODEL

log = logging.getLogger(__name__)

_model = None
_lock = threading.Lock()


def get_model():
    """Load (once) and return the SentenceTransformer."""
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from sentence_transformers import SentenceTransformer

                log.info("loading embedding model %s", EMBEDDING_MODEL)
                _model = SentenceTransformer(EMBEDDING_MODEL, device="cpu")
    return _model


def embed(texts: list[str], batch_size: int = 64, progress: bool = False) -> np.ndarray:
    """Encode texts to L2-normalised float32 vectors.

    Normalising here means cosine similarity is a plain dot product, which is
    what both the FAISS inner-product index and the numpy fallback expect.
    """
    vectors = get_model().encode(
        texts,
        batch_size=batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=progress,
    )
    return np.asarray(vectors, dtype="float32")


def embedding_dim() -> int:
    return int(get_model().get_sentence_embedding_dimension())
