"""Eager warmup of the assistant stack (embedding model + hybrid index).

The first `/ask` used to pay the entire cold-start bill: ~90MB MiniLM download/
load, a 16MB `embeddings.npy`, a 30MB `tfidf.pkl`, plus sentence-transformers'
own first-call initialisation. That is far longer than the mobile client's
timeout, so the first question always failed.

This module loads all of it once, immediately at process boot, on a background
thread:

  * Booting in the background (rather than blocking the ASGI startup hook) keeps
    `/health` answerable from the first second. Free-tier hosts kill a container
    whose health check does not answer during a long startup, and the keep-alive
    ping needs a live endpoint to hit while the model is still loading.
  * `/ask` calls `wait()`, so a request that lands mid-warmup blocks on the
    already-running load instead of starting a second one -- from the client's
    point of view this behaves exactly like a blocking startup.
  * The double-checked locks in `embedder.get_model` / `retriever.get_index`
    remain the ultimate guard: even if warmup is skipped or fails, a lazy caller
    still loads exactly once.

Set MEDIGUARD_BLOCK_ON_WARMUP=1 to make startup block until warmup finishes
instead (useful behind a load balancer that only routes once startup returns).
"""
from __future__ import annotations

import logging
import os
import threading
import time

log = logging.getLogger(__name__)

# How long /ask is willing to wait for an in-flight warmup before giving up and
# telling the caller to retry.
WAIT_TIMEOUT = float(os.environ.get("MEDIGUARD_WARMUP_TIMEOUT", "300"))

_done = threading.Event()
_thread: threading.Thread | None = None
_start_lock = threading.Lock()

_state: dict = {
    "status": "pending",  # pending -> warming -> ready | failed
    "seconds": None,
    "model_seconds": None,
    "index_seconds": None,
    "chunks": None,
    "error": None,
}


def status() -> dict:
    """Snapshot of warmup progress. Never touches a model."""
    return dict(_state)


def is_ready() -> bool:
    return _state["status"] == "ready"


def _run() -> None:
    started = time.time()
    _state.update(status="warming", error=None)
    try:
        from app.assistant.embedder import embed
        from app.assistant.retriever import get_index

        # Loading the model is only half the cold start: sentence-transformers
        # defers tokeniser setup, the pooling graph and torch's first kernel
        # dispatch to the first encode(). Burn a throwaway encode here so the
        # first real question does not pay for it.
        t0 = time.time()
        embed(["mediguard warmup"])
        model_seconds = time.time() - t0
        # Recorded as we go, so a later failure still shows how far warmup got.
        _state["model_seconds"] = round(model_seconds, 2)
        log.info("embedding model warm in %.2fs", model_seconds)

        t1 = time.time()
        index = get_index()
        index_seconds = time.time() - t1
        _state["index_seconds"] = round(index_seconds, 2)

        _state.update(
            status="ready",
            seconds=round(time.time() - started, 2),
            chunks=len(index),
        )
        log.info(
            "warmup complete in %.2fs (model %.2fs, index %.2fs, %d chunks)",
            _state["seconds"], model_seconds, index_seconds, len(index),
        )
    except Exception as exc:  # noqa: BLE001 - a failed warmup must not kill the process
        _state.update(
            status="failed",
            seconds=round(time.time() - started, 2),
            error="%s: %s" % (type(exc).__name__, exc),
        )
        # The lazy loaders stay usable, so /ask can still surface the real error
        # (or succeed, if whatever was missing has since appeared).
        log.exception("warmup failed after %.2fs", _state["seconds"])
    finally:
        _done.set()


def start() -> None:
    """Kick off warmup once. Safe to call repeatedly."""
    global _thread
    with _start_lock:
        if _thread is not None:
            return
        _thread = threading.Thread(target=_run, name="assistant-warmup", daemon=True)
        _thread.start()
        log.info("assistant warmup started in background")


def wait(timeout: float | None = WAIT_TIMEOUT) -> bool:
    """Block until warmup has finished (ready *or* failed).

    Returns True if it finished, False on timeout. Starts warmup if it somehow
    never ran, so a request is never the thing that silently skips it.
    """
    if _thread is None:
        start()
    return _done.wait(timeout)
