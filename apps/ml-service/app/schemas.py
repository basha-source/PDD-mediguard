"""Request/response models.

These deliberately mirror the legacy Gemini-backed JSON shapes byte-for-byte so
the Node routes stay a pass-through and the mobile app needs zero changes.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Mode = Literal["expiry", "packaging", "prescription"]
Category = Literal["tablet", "capsule", "liquid", "injection", "other"]


class OcrRequest(BaseModel):
    image: str = Field(..., description="base64-encoded JPEG/PNG, with or without data: prefix")
    mode: Mode


class ExpiryResponse(BaseModel):
    expiry: Optional[str] = None


class PackagingResponse(BaseModel):
    name: str = ""
    dosage: str = ""
    category: Category = "other"
    expiryDate: Optional[str] = None


class PrescriptionMedicine(BaseModel):
    name: str
    dosage: str = ""
    category: Category = "other"
    # Lexicon match score, 0-1. Additive to the legacy shape: older clients
    # ignore the field, so the /ocr contract stays backward compatible while the
    # confirm screen can pre-tick only what matched strongly.
    confidence: float = 1.0


class PrescriptionResponse(BaseModel):
    medicines: list[PrescriptionMedicine] = []
    # Set when the page was rejected before matching, e.g. "not_prescription".
    # Additive: older clients read `medicines` and simply see an empty list.
    reason: Optional[str] = None


class AskRequest(BaseModel):
    question: str


class AskResponse(BaseModel):
    answer: str
