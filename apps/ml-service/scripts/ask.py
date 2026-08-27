#!/usr/bin/env python
"""Interactive console for the assistant (Feature 3) -- no server needed.

    python scripts/ask.py                      # interactive prompt
    python scripts/ask.py "can I drink alcohol on antibiotics"
    python scripts/ask.py --debug "side effects of metformin"

--debug also prints the retrieved passages and their scores, which is the fast
way to tell a retrieval problem apart from an answer-composition problem.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def show(question: str, debug: bool) -> None:
    from app.assistant.answer import answer_question
    from app.assistant.retriever import intended_sections, search_relevant

    started = time.time()
    if debug:
        hits = search_relevant(question)
        wanted = intended_sections(question)
        print("\n  intent sections: %s" % (sorted(wanted) or "(none detected)"))
        print("  retrieved %d passages:" % len(hits))
        for i, hit in enumerate(hits, 1):
            print("   %d. score=%.3f (dense=%.2f lexical=%.2f)  %s / %s [%s]"
                  % (i, hit.score, hit.dense, hit.lexical,
                     hit.record["title"][:40], hit.record["section"], hit.record["source"]))
            print("      %s..." % hit.record["text"][:110].replace("\n", " "))

    answer = answer_question(question)
    print("\n" + answer)
    print("\n  [%.2fs]" % (time.time() - started))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("question", nargs="*", help="question to ask; omit for interactive mode")
    ap.add_argument("--debug", action="store_true", help="also show retrieved passages")
    args = ap.parse_args()

    if args.question:
        show(" ".join(args.question), args.debug)
        return

    print("MediGuard assistant -- type a question, or 'quit' to exit.")
    print("Loading the index and embedding model (first question takes ~15s)...\n")
    while True:
        try:
            question = input("you > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if question.lower() in {"quit", "exit", "q"}:
            return
        if question:
            show(question, args.debug)
            print()


if __name__ == "__main__":
    main()
