"""Text extraction from pack/prescription images (Feature 1 and 2).

PaddleOCR is the default detector+recogniser. It was chosen over Tesseract
because medicine packaging is curved, glossy, multi-coloured and multi-font,
which is exactly where Tesseract's page-segmentation assumptions break down;
Paddle's detection stage finds arbitrarily oriented text boxes first and
recognises each crop separately. `scripts/ablation.py` measures the difference,
and the Tesseract path below exists so that comparison is runnable.

The engine is imported lazily: the FastAPI process must boot (and answer
/health) without paying the model-load cost.
"""
from __future__ import annotations

import base64
import binascii
import io
import logging
import re
import threading
from dataclasses import dataclass

import numpy as np

from app.config import OCR_LANG

log = logging.getLogger(__name__)

_DATA_URI = re.compile(r"^data:image/[a-zA-Z0-9.+-]+;base64,")


class OcrUnavailable(RuntimeError):
    """Raised when no OCR backend can be loaded."""


@dataclass
class OcrLine:
    text: str
    confidence: float
    box: list[list[float]] | None = None

    @property
    def height(self) -> float:
        """Text height in pixels -- used as a prior for finding the brand name,
        which is nearly always the largest text on a pack."""
        if not self.box:
            return 0.0
        ys = [point[1] for point in self.box]
        return float(max(ys) - min(ys))

    @property
    def top(self) -> float:
        return float(min(point[1] for point in self.box)) if self.box else 0.0


def decode_image(image: str) -> np.ndarray:
    """base64 (with or without a data: prefix) -> RGB numpy array."""
    from PIL import Image

    payload = _DATA_URI.sub("", (image or "").strip())
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image is not valid base64") from exc
    if not raw:
        raise ValueError("image is empty")
    try:
        pil = Image.open(io.BytesIO(raw))
        pil.load()
    except Exception as exc:  # noqa: BLE001 - any decode failure is a bad image
        raise ValueError("image could not be decoded") from exc
    return np.array(pil.convert("RGB"))


_paddle = None
_lock = threading.Lock()


def _get_paddle():
    global _paddle
    if _paddle is None:
        with _lock:
            if _paddle is None:
                # Import torch first, and never the other way round.
                #
                # On Windows, paddlepaddle and torch ship their own copies of the
                # Intel OpenMP/MKL runtime. Whichever loads first wins the DLL
                # search for the rest of the process: with paddle first, torch's
                # later load fails with "WinError 127 ... shm.dll", which takes
                # the MiniLM embedder -- and therefore the whole assistant --
                # down with it. Loading torch first leaves both working.
                #
                # The service normally warms the embedder at boot, so torch is
                # already resident by the time any /ocr arrives; this line makes
                # the guarantee explicit rather than incidental, and covers the
                # case where OCR is exercised on its own (tests, ablations).
                # Harmless on Linux, where the container has one OpenMP runtime.
                try:
                    import torch  # noqa: F401
                except ImportError:
                    pass

                try:
                    from paddleocr import PaddleOCR
                except ImportError as exc:
                    raise OcrUnavailable(
                        "paddleocr is not installed -- pip install -r requirements-ocr.txt"
                    ) from exc
                log.info("loading PaddleOCR (lang=%s)", OCR_LANG)
                _paddle = PaddleOCR(use_angle_cls=True, lang=OCR_LANG, show_log=False)
    return _paddle


def paddle_lines(image: np.ndarray) -> list[OcrLine]:
    result = _get_paddle().ocr(image, cls=True)
    lines: list[OcrLine] = []
    # PaddleOCR returns [page][line] = [box, (text, confidence)]; a page with no
    # detections comes back as [None].
    for page in result or []:
        for entry in page or []:
            box, (text, confidence) = entry[0], entry[1]
            text = (text or "").strip()
            if text:
                lines.append(OcrLine(text=text, confidence=float(confidence), box=box))
    return lines


def tesseract_lines(image: np.ndarray) -> list[OcrLine]:
    """Baseline backend for the ablation study. Not used in production."""
    try:
        import pytesseract
        from pytesseract import Output
    except ImportError as exc:
        raise OcrUnavailable("pytesseract is not installed") from exc

    data = pytesseract.image_to_data(image, output_type=Output.DICT)
    grouped: dict[tuple, list[int]] = {}
    for i, text in enumerate(data["text"]):
        if not (text or "").strip():
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        grouped.setdefault(key, []).append(i)

    lines: list[OcrLine] = []
    for indices in grouped.values():
        text = " ".join(data["text"][i].strip() for i in indices)
        confidences = [float(data["conf"][i]) for i in indices if float(data["conf"][i]) >= 0]
        left = min(data["left"][i] for i in indices)
        top = min(data["top"][i] for i in indices)
        right = max(data["left"][i] + data["width"][i] for i in indices)
        bottom = max(data["top"][i] + data["height"][i] for i in indices)
        lines.append(OcrLine(
            text=text,
            confidence=(sum(confidences) / len(confidences) / 100.0) if confidences else 0.0,
            box=[[left, top], [right, top], [right, bottom], [left, bottom]],
        ))
    return lines


def extract_lines(image: str | np.ndarray, backend: str = "paddle") -> list[OcrLine]:
    """Read text from a base64 string or an already-decoded array."""
    array = decode_image(image) if isinstance(image, str) else image
    if backend == "tesseract":
        return tesseract_lines(array)
    return paddle_lines(array)


def is_available(backend: str = "paddle") -> bool:
    try:
        _get_paddle() if backend == "paddle" else __import__("pytesseract")
        return True
    except Exception:  # noqa: BLE001
        return False
