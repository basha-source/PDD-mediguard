"""MediGuard ML service.

Replaces the Gemini API behind the Node backend's /ocr and /ask routes. The
response bodies here are byte-identical to what Gemini used to return, so the
Node routes are a pass-through and the mobile app needs no changes.

The embedding model and the assistant index are warmed at boot (see
`app.assistant.warmup`) so the first /ask does not pay the cold-start cost.

Run locally:
    uvicorn app.main:app --port 8000 --app-dir apps/ml-service
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.schemas import AskRequest, AskResponse, OcrRequest

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("mediguard.ml")

# Blocking startup is opt-in: by default warmup runs in the background so
# /health answers immediately (free-tier hosts kill containers that go silent
# during a long startup) while /ask waits on the same one-shot load.
BLOCK_ON_WARMUP = os.environ.get("MEDIGUARD_BLOCK_ON_WARMUP", "0").lower() in {"1", "true", "yes"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    from app.assistant import warmup

    started = time.time()
    warmup.start()
    if BLOCK_ON_WARMUP:
        # Run the wait off the event loop so /health stays answerable even here.
        await asyncio.get_running_loop().run_in_executor(None, warmup.wait)
        log.info("startup blocked %.2fs for warmup: %s", time.time() - started, warmup.status())
    yield
    log.info("shutting down")


app = FastAPI(title="MediGuard ML Service", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.exception_handler(Exception)
async def unhandled_error(_request: Request, exc: Exception) -> JSONResponse:
    """Anything that escapes a route comes back as structured JSON, so the Node
    backend can surface a cause instead of an opaque 500 traceback."""
    log.exception("unhandled error")
    return JSONResponse(
        status_code=500, content={"error": "%s: %s" % (type(exc).__name__, exc)}
    )


@app.get("/")
def root() -> dict:
    return {"status": "ok", "service": "MediGuard ML", "endpoints": ["/health", "/ocr", "/ask"]}


@app.get("/health")
def health() -> dict:
    """Cheap liveness probe -- also what the keep-alive ping hits, so it must
    never touch a model. Everything below is either an in-memory flag or a
    136-byte manifest read."""
    from app.assistant import retriever, warmup

    warm = warmup.status()
    status: dict = {
        "status": "ok",
        "service": "MediGuard ML",
        # Retained for the Node backend, which already reads this field.
        "index_loaded": retriever.is_ready(),
        "ready": warm["status"] == "ready",
        "warmup": warm,
    }
    try:
        from app.assistant.index import MANIFEST_PATH

        if MANIFEST_PATH.exists():
            import json

            status["index"] = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - health must not fail on a missing index
        pass
    return status


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest):
    question = (req.question or "").strip()
    if not question:
        return AskResponse(answer="Please ask a question about your medication.")

    started = time.time()

    # A request that lands mid-warmup waits on the load already in flight. The
    # double-checked locks in embedder/retriever mean even a wait that times out
    # cannot start a second copy of the model.
    from app.assistant import warmup

    if not warmup.wait():
        log.error("/ask timed out waiting for warmup after %.2fs", time.time() - started)
        return JSONResponse(
            status_code=503,
            content={"error": "assistant is still warming up, please retry shortly"},
        )

    try:
        from app.assistant.answer import answer_question

        answer = answer_question(question)
    except FileNotFoundError as exc:
        log.error("index missing: %s", exc)
        return JSONResponse(status_code=503, content={"error": "assistant index not built"})
    except Exception as exc:  # noqa: BLE001 - never leak a traceback to the app
        log.exception("/ask failed for %r", question[:60])
        return JSONResponse(
            status_code=500, content={"error": "%s: %s" % (type(exc).__name__, exc)}
        )
    log.info("/ask %.2fs %r", time.time() - started, question[:60])
    return AskResponse(answer=answer)


@app.post("/ocr")
def ocr(req: OcrRequest):
    started = time.time()
    try:
        from app.ocr.pipeline import run_ocr

        result = run_ocr(req.image, req.mode)
    except Exception as exc:  # noqa: BLE001 - structured error, not a traceback
        log.exception("/ocr failed mode=%s", req.mode)
        return JSONResponse(
            status_code=500, content={"error": "%s: %s" % (type(exc).__name__, exc)}
        )
    log.info("/ocr mode=%s %.2fs", req.mode, time.time() - started)
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
