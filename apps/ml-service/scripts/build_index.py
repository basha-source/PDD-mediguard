#!/usr/bin/env python
"""Embed data/corpus.jsonl and write the searchable index (Feature 3).

Usage:
    python scripts/build_index.py
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.assistant.index import build  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
