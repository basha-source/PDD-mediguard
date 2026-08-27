"""Vector + lexical index over the assistant corpus (Feature 3).

Layout under data/index/:
    embeddings.npy   float32 [N, D], L2-normalised MiniLM vectors
    meta.jsonl       one corpus record per row, aligned with embeddings.npy
    tfidf.pkl        fitted TF-IDF vectoriser + sparse doc matrix
    manifest.json    model name, dimensions, build time

Dense search uses FAISS `IndexFlatIP` when faiss is importable and falls back to
an exact numpy dot product otherwise -- at corpus sizes in the tens of thousands
both are exact and the numpy path is fast enough, so the fallback costs no
accuracy. That keeps the Space deployable even if the faiss wheel is unavailable.
"""
from __future__ import annotations

import json
import logging
import pickle
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.config import CORPUS_PATH, INDEX_DIR

log = logging.getLogger(__name__)

EMB_PATH = INDEX_DIR / "embeddings.npy"
META_PATH = INDEX_DIR / "meta.jsonl"
TFIDF_PATH = INDEX_DIR / "tfidf.pkl"
MANIFEST_PATH = INDEX_DIR / "manifest.json"


def load_corpus(path: Path = CORPUS_PATH) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError(
            "corpus not found at %s -- run scripts/build_corpus.py first" % path
        )
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def build(corpus_path: Path = CORPUS_PATH, index_dir: Path = INDEX_DIR) -> dict:
    """Embed the corpus and write every index artefact. Returns a manifest."""
    from sklearn.feature_extraction.text import TfidfVectorizer

    from app.assistant.embedder import embed

    records = load_corpus(corpus_path)
    texts = [r["text"] for r in records]
    log.info("embedding %d chunks", len(texts))

    started = time.time()
    vectors = embed(texts, progress=True)

    # Lexical half of the hybrid: word-level TF-IDF catches exact drug names and
    # rare terms that a 384-dim dense vector tends to smooth away.
    vectorizer = TfidfVectorizer(
        lowercase=True, stop_words="english", ngram_range=(1, 2),
        min_df=1, max_df=0.6, sublinear_tf=True,
    )
    doc_matrix = vectorizer.fit_transform(texts)

    index_dir.mkdir(parents=True, exist_ok=True)
    np.save(EMB_PATH, vectors)
    with META_PATH.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with TFIDF_PATH.open("wb") as fh:
        pickle.dump({"vectorizer": vectorizer, "matrix": doc_matrix}, fh)

    from app.config import EMBEDDING_MODEL

    manifest = {
        "chunks": len(records),
        "dim": int(vectors.shape[1]),
        "model": EMBEDDING_MODEL,
        "build_seconds": round(time.time() - started, 1),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log.info("index built: %s", manifest)
    return manifest


@dataclass
class Hit:
    score: float
    dense: float
    lexical: float
    record: dict


class Index:
    """Loaded, queryable index. Construct via `Index.load()`."""

    def __init__(self, vectors: np.ndarray, records: list[dict], tfidf: dict | None):
        self.vectors = vectors
        self.records = records
        self.vectorizer = tfidf["vectorizer"] if tfidf else None
        self.doc_matrix = tfidf["matrix"] if tfidf else None
        self._faiss = None
        try:
            import faiss  # type: ignore

            index = faiss.IndexFlatIP(vectors.shape[1])
            index.add(vectors)
            self._faiss = index
            log.info("dense search backend: faiss IndexFlatIP")
        except Exception:  # noqa: BLE001 - fallback is exact, just slower
            log.info("dense search backend: numpy (faiss unavailable)")

    @classmethod
    def load(cls, index_dir: Path = INDEX_DIR) -> "Index":
        emb = index_dir / "embeddings.npy"
        meta = index_dir / "meta.jsonl"
        if not emb.exists() or not meta.exists():
            raise FileNotFoundError(
                "index not found in %s -- run scripts/build_index.py first" % index_dir
            )
        vectors = np.load(emb).astype("float32")
        with meta.open(encoding="utf-8") as fh:
            records = [json.loads(line) for line in fh if line.strip()]
        tfidf = None
        tfidf_path = index_dir / "tfidf.pkl"
        if tfidf_path.exists():
            with tfidf_path.open("rb") as fh:
                tfidf = pickle.load(fh)
        return cls(vectors, records, tfidf)

    def __len__(self) -> int:
        return len(self.records)

    def manifest(self) -> dict:
        if MANIFEST_PATH.exists():
            return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        return {"chunks": len(self.records), "dim": int(self.vectors.shape[1])}

    def dense_scores(self, query_vector: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
        k = min(k, len(self.records))
        if self._faiss is not None:
            scores, idx = self._faiss.search(query_vector.reshape(1, -1), k)
            return scores[0], idx[0]
        sims = self.vectors @ query_vector.reshape(-1)
        idx = np.argpartition(-sims, k - 1)[:k]
        idx = idx[np.argsort(-sims[idx])]
        return sims[idx], idx

    def lexical_scores(self, question: str, k: int) -> dict[int, float]:
        if self.vectorizer is None:
            return {}
        query = self.vectorizer.transform([question])
        sims = (self.doc_matrix @ query.T).toarray().reshape(-1)
        k = min(k, len(sims))
        idx = np.argpartition(-sims, k - 1)[:k]
        return {int(i): float(sims[i]) for i in idx if sims[i] > 0}
