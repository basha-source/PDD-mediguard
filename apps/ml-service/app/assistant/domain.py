"""Domain gating for the assistant (Feature 3).

Retrieval alone cannot tell "hello" apart from "what is the dose of Xyzdrug".
Both return zero hits, so both used to get the same careful reply -- "I don't
have reliable information on that in my medical reference library". That is the
right answer to the second question and a strange one to the first.

This module splits the zero-hit case in two:

  * A bare greeting or a bit of small talk is recognised by pattern, before any
    retrieval runs, and gets a welcome that says what the assistant is for.
  * Anything else that retrieved nothing is checked semantically against a set
    of medical prototype phrases. Below the threshold it is off-domain and gets
    a redirect; above it, it is a medical question we simply have no passage
    for, and it keeps the original careful wording.

Neither reply carries SAFETY_LINE. That line exists to qualify medical
information, and these two replies contain none -- appending "always consult a
doctor" to "Hi!" reads as a non sequitur and dilutes the line where it matters.

The error cost here is asymmetric: sending a real medical question to the
off-domain reply brushes off a patient who needed an answer, while letting an
off-topic question through merely produces a slightly formal refusal. The
threshold is therefore tuned to protect medical recall.
"""
from __future__ import annotations

import re

# Anchored to the WHOLE message, not searched inside it. "hi" is a greeting;
# "hi what are the side effects of aspirin" is a medical question that happens
# to open politely, and a substring match would misroute it to the welcome text.
_GREETING = re.compile(
    r"""^\s*
    (?:hi+|hey+|hello+|yo|hola|namaste|greetings
      |good\s*(?:morning|afternoon|evening|day|night))
    [\s!.,?]*$""",
    re.IGNORECASE | re.VERBOSE,
)

# Small talk about the assistant itself. The welcome reply already answers all
# of these ("who are you", "what can you do"), so they share it.
_SMALLTALK = re.compile(
    r"""^\s*
    (?:who\s+(?:are|r)\s+(?:you|u)
      |what(?:'?s|\s+is)\s+your\s+name
      |what\s+(?:can|do)\s+you\s+do
      |how\s+are\s+you
      |are\s+you\s+(?:a\s+)?(?:bot|robot|human|ai|real|doctor)
      |thanks?(?:\s+you)?|thank\s+you|thx
      |ok(?:ay)?|cool|nice|good|great
      |bye|goodbye|see\s+you
      |test(?:ing)?)
    [\s!.,?]*$""",
    re.IGNORECASE | re.VERBOSE,
)

# Short phrasings of the things this corpus actually covers. Kept generic and
# drug-free on purpose: naming real drugs would pull the centroid toward those
# specific molecules, and a question about an unlisted drug is exactly the case
# that must still read as medical.
MEDICAL_PROTOTYPES: list[str] = [
    "What are the side effects of this medicine or drug?",
    "What is the correct dose of this medication, how many tablets?",
    "How often should I take this medicine each day?",
    "Can I drink alcohol while taking this medication?",
    "Should this tablet be taken with food or on an empty stomach?",
    "Does this drug interact with other medicines I am taking?",
    "Is this medication safe to take during pregnancy?",
    "Is this drug safe while breastfeeding or nursing?",
    "What happens if I overdose or take too many tablets?",
    "What illness or condition is this medicine used to treat?",
    "Who should not take this drug, and what are the contraindications?",
    "I am allergic to this medication, can I still take it?",
    "How should I store this medicine, and does it expire?",
    "What should I take for my headache, fever or pain?",
    "Is this painkiller or antibiotic safe for me to take?",
    "Can a child take this medicine, what is the paediatric dose?",
    "What should I do if I miss a dose of my tablets?",
    "How long does this medication take to work, and is it addictive?",
    "paracetamol ibuprofen aspirin tablets capsules prescription drug",
    "Is it okay to drink grapefruit juice with this medicine?",
    "How long before this tablet starts working and wears off?",
    "amoxicillin 500mg tablet",
]

# Cosine similarity below this, with no retrieval hits, means off-domain.
# Swept from 0.10 to 0.60 against 110 labelled questions: 0.32 sits mid-plateau
# at medical recall 0.983 / off-domain recall 0.920. A higher 0.40 scores a
# point better overall but sits on a cliff edge -- medical recall falls to 0.90
# by 0.42 and 0.80 by 0.50. Given the asymmetric cost above, the margin is
# worth more than the point.
DOMAIN_THRESHOLD = 0.32

GREETING_REPLY = (
    "Hi! I'm MediGuard AI \U0001F44B\n\n"
    "I can help with questions about your medicines — dosages, side effects, "
    "interactions, storage and safety.\n\n"
    "Try asking me:\n"
    "• What are the side effects of Ibuprofen?\n"
    "• Can I take Aspirin and Paracetamol together?\n"
    "• How should I store my medicines?"
)

OFF_DOMAIN_REPLY = (
    "That's outside what I can help with — I'm MediGuard AI, so I stick to "
    "questions about medicines and medication safety.\n\n"
    "Try asking me:\n"
    "• What are the side effects of Ibuprofen?\n"
    "• Can I take Aspirin and Paracetamol together?\n"
    "• How should I store my medicines?"
)


def is_greeting(question: str) -> bool:
    """True for a bare greeting or a bit of small talk about the assistant.

    Matched before retrieval, so these cost neither an embed nor a search.
    """
    return bool(_GREETING.match(question) or _SMALLTALK.match(question))


def looks_medical(question: str) -> bool:
    """Semantic check for a question that retrieved nothing.

    True means "medical, but not in our corpus" -- keep the careful reply.
    False means off-domain -- redirect.
    """
    # A one- or two-word query carries too little signal for the gate to read:
    # a bare drug name we do not stock ("Xyzdrug") scores ~0.20 against every
    # prototype and would be turned away as off-topic, which is the expensive
    # mistake. Treat a fragment that short as medical and let NO_ANSWER answer
    # it; being wrong here just means a formal reply to "cricket". Greetings
    # never reach this branch -- they are matched by pattern first.
    if len(question.split()) <= 2:
        return True

    from app.assistant.embedder import embed

    # embed() returns L2-normalised rows, so a dot product is the cosine.
    vectors = embed([question] + MEDICAL_PROTOTYPES)
    similarity = float((vectors[1:] @ vectors[0]).max())
    return similarity >= DOMAIN_THRESHOLD
