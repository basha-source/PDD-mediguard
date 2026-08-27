# MediGuard — AI Migration Plan (Gemini → our own ML)

Working document. Start date: tomorrow.

## Goal

Remove the Gemini API from **every** call site and replace it with ML/NLP we build and own,
without changing the mobile app. The college's actual complaint was "no measurable ML work" —
so every feature below has to ship with numbers (see [Metrics](#metrics)).

Hard constraint: the mobile app must need **zero changes**. Request/response shapes of
`/ocr` and `/ask` stay byte-identical.

---

## What must change

### 1. `apps/backend/src/routes/medicines.ts` → `POST /ocr` (lines 73–129)

One endpoint, three modes, all three currently hit `gemini-2.5-flash` with a base64 image
plus a JSON-output prompt (models array on line 92, retry loop lines 104–126).

| mode | current prompt asks for | response shape (must keep) |
|---|---|---|
| `expiry` | expiry date only | `{"expiry": "YYYY-MM-DD" \| null}` |
| `packaging` | name/dosage/category/expiry | `{"name","dosage","category","expiryDate"}` |
| `prescription` | list of medicines | `{"medicines":[{"name","dosage","category"}]}` |

`category` is one of `tablet | capsule | liquid | injection | other`.

### 2. `apps/backend/src/routes/ai.ts` → `POST /ask` (lines 14–41)

Single prompt to `gemini-2.5-flash`, no retrieval, no context. In → `{"question": "..."}`,
out → `{"answer": "..."}`.

### NOT affected — do not touch

`GET /lookup` in `medicines.ts` (lines 46–71) is **barcode lookup only** — OpenFDA +
UPCitemdb over HTTP. There is no AI in it. Nobody should spend time here.

Also delete once the migration is done: `ENV.GEMINI_API_KEY`, `API.GEMINI_BASE` in the
shared package, and the Gemini env var in `render.yaml`.

---

## Architecture

The Node backend on Render's free tier has **512MB RAM** — it cannot host PaddleOCR, TrOCR,
or a sentence-transformer. So:

```
Expo app  ──►  Node/Express (Render free, 512MB)  ──►  Python FastAPI ML service
              /ocr, /ask, /lookup                       (HF Spaces free CPU, 2 vCPU / 16GB)
              unchanged shapes                          PaddleOCR, TrOCR, MiniLM, SQLite DB
```

- Node keeps the routes and the response shapes. It becomes a **thin proxy**: same JSON in,
  same JSON out, just `axios.post(ML_SERVICE_URL + "/ocr", ...)` instead of Gemini.
- New service lives at `apps/ml-service/` (Python 3.11, FastAPI, `requirements.txt`,
  `Dockerfile`), deployed to a Hugging Face Space.
- Node gets one new env var: `ML_SERVICE_URL`.

**Tradeoff to plan around:** HF Spaces free tier sleeps when idle → **~30s cold start** on
the first scan of the day. Mitigate with (a) a keep-alive ping every ~10 min (cron-job.org or
a Render cron) and (b) a proper loading state in the app for the first request. Say this out
loud in the viva rather than hiding it.

- [ ] Scaffold `apps/ml-service/` (FastAPI + `/health`, `/ocr`, `/ask`)
- [ ] Dockerfile + HF Space, confirm it boots on free CPU
- [ ] Add `ML_SERVICE_URL` to backend env + `render.yaml`
- [ ] Set up keep-alive ping
- [ ] Rewrite the two Node routes as proxies (behind a flag so we can fall back during dev)

---

## Feature 1 — Packaging + expiry OCR

Strongest and lowest risk. Covers 2 of the 3 `/ocr` modes.

**Text extraction:** PaddleOCR on CPU, ~1–2s/image. Chosen over Tesseract because medicine
boxes are curved, colored, and multi-font — Tesseract collapses on those. Output = raw text
lines with confidence scores.

**Expiry (mode `expiry`)** — deterministic, no model at all:
- Regex + `dateutil` over the OCR lines. Handle `EXP`, `E`, `EXP.`, `Use before`, `Best before`,
  `MFG` (to exclude it), and formats `MM/YYYY`, `MM-YY`, `MMM YYYY`, `DD/MM/YYYY`.
- Normalize to `YYYY-MM-DD`; a month-only date maps to the last day of that month.
- Return `null` if nothing parses — same as today.

**Name / dosage / category (mode `packaging`)**:
- Dosage: regex for `500mg`, `10ml`, `2.5 mg`, `500 MG`, `10 mcg`, `5%`.
- Name: fuzzy-match each OCR line against our own medicine DB — **RapidFuzz** for edit distance
  plus a **TF-IDF character n-gram (3–5)** retriever for the candidate shortlist. Take best score.
- Category: read straight off the matched DB row (dosage form → `tablet|capsule|liquid|injection|other`,
  reuse the existing `mapCategory` logic).

**Our medicine database** — this is a key defensible artifact of the project:
- Sources: CDSCO / India drug list + an openFDA label dump.
- Target ~50–100k rows in **SQLite**: `name`, `generic`, `strength`, `dosage_form`, `manufacturer`.
- Ship the `.db` file in the repo/Space so the whole thing is reproducible offline.

- [ ] Build the CDSCO + openFDA ingest script → `medicines.db`
- [ ] Wire PaddleOCR, verify latency on HF free CPU
- [ ] Expiry date parser + unit tests over real box strings
- [ ] Dosage regex
- [ ] RapidFuzz + TF-IDF name matcher over `medicines.db`
- [ ] `/ocr` modes `expiry` and `packaging` returning the exact legacy JSON

---

## Feature 2 — Prescription reading

Hardest. **Do this last.** Split the problem in two:

**Printed / pharmacy-typed prescriptions** — same pipeline as Feature 1 (PaddleOCR + DB
matching). This will work well and covers a real share of cases.

**Handwritten** — fine-tune **`microsoft/trocr-small-handwritten`** (small, *not* base —
base is too slow for CPU inference) on **Colab free GPU**.
- Datasets: "Doctor's Handwritten Prescription" (Kaggle) + IAM handwriting dataset.
- Train in Colab, export the checkpoint, load it in the Space.

**Key technique — constrained / lexicon-based matching, not open-vocabulary OCR:**
detect word crops → TrOCR emits a noisy string → snap it to the nearest entry in our
medicine DB. The model is choosing from ~50k known names instead of any possible string,
which lifts accuracy a lot. This is the strongest single design decision in the project —
prepare to defend it in the viva with the ablation numbers.

**Be honest:** handwritten results will be worse than Gemini. Absorb the error in the UI —
add a **"confirm / edit detected medicines"** screen after a prescription scan. Good UX for a
medication app regardless, and it makes model error recoverable instead of dangerous.

- [x] Printed-prescription path through the Feature 1 pipeline
- [ ] Collect + clean Kaggle prescription dataset, merge with IAM (runs inside the
      notebook -- needs a Kaggle API token and the dataset slug confirmed)
- [x] Colab notebook: fine-tune `trocr-small-handwritten`, log CER per epoch
      (`notebooks/trocr_finetune.ipynb`; exports the checkpoint *and* the held-out
      split that `scripts/ablation.py --trocr` scores)
- [x] Word-crop detection (PaddleOCR detector) feeding TrOCR
- [x] Lexicon snapping against `medicines.db`
- [x] App: confirm/edit detected medicines screen

**Measured (ablation 1, n=35):** lexicon snapping vs raw OCR line, by OCR noise --
0%: +0.0 pts | 5%: +17.1 | 10%: +29.1 | 20%: +43.4. At zero noise the lexicon adds
nothing, which is the honest result; its value is entirely in recovering degraded
text, and handwriting is the degraded case. This is the number to defend in the viva.

### Rejecting things that are not prescriptions

Any photograph with text on it used to yield "medicines". Two independent causes,
fixed separately:

**1. The lexicon contained ordinary English words.** openFDA is a registry of
everything holding an NDC code, not a formulary: 19,331 rows were homeopathic
preparations -- unambiguous via the `[hp_X]` / `[hp_C]` potency notation in their
strength -- and hundreds more were botanical extracts named `RICE`, `Oil`,
`THE SOLUTION`. A shopping-list line "Rice 5 kg" matched `RICE` at **0.862**: a
*correct* match against a row that should never have been matchable, which is
exactly why no score threshold could have fixed it. `matcher.py` now excludes
those rows at load time -- 93,822 raw rows -> 43,743 matchable names.

Removing them **improved** every metric, because they were competing distractors:
name-matching top-1 at 10% corruption 90.8% -> 93.4%, at 5% 96.2% -> 97.0%, and
the lexicon ablation at 20% noise +42.3 -> +43.4 pts.

**2. No document-level check.** `looks_like_prescription()` now requires at least
one medical token (dose units, dose forms, OD/BD/TDS/SOS, clinic furniture)
before matching runs, and returns `reason: "not_prescription"` rather than an
empty list, so the app can say what actually happened instead of blaming the
photo. The gate is skipped below 3 readable lines: a handwritten sheet returns
almost no printed text, and gating there would block the TrOCR path before it
ever ran.

**3. Confidence on every detection.** `/ocr` returns a `confidence` per medicine
(additive to the legacy shape); the confirm screen leaves anything under 0.80
unticked. Server-side filtering alone would silently drop a real medicine that
scanned badly, and a silent miss is invisible to the user -- whereas an unticked
row is still one tap from being kept.

Verified end to end: shopping list -> 0 medicines (`not_prescription`), office
memo -> 0 (`not_prescription`), real prescription -> exactly 4, all ticked,
medicine-box scanning unaffected.

---

## Feature 3 — AI assistant (replaces `/ask`)

**RAG over our own corpus, extractive-first, no LLM in the default path.**

- **Corpus:** openFDA drug labels (indications, warnings, side effects, interactions) +
  MedlinePlus + a curated FAQ set. Chunked (~200–400 tokens, with overlap).
- **Embeddings:** `all-MiniLM-L6-v2` via `sentence-transformers` — 90MB, fast on CPU.
- **Index:** FAISS (or `sqlite-vec` if we want one less dependency).
- **Answer:** retrieve top-k passages, render through a template, always with the source
  citation and the existing "consult a doctor" safety line. Return as `{"answer": "..."}`.

Zero hallucination and every answer traceable to a labeled source. For a medical app this is
a **genuine advantage over Gemini**, not a compromise — frame it that way.

Optional, later, only if time allows: a small local generator that *only rephrases retrieved
text* — Flan-T5-base (250MB) or Qwen2.5-1.5B-Instruct. Costs real CPU latency on the free
tier; not required for the deliverable.

- [x] Pull + chunk openFDA labels and MedlinePlus
- [x] Write the curated FAQ set
- [x] Embed with MiniLM, build FAISS index, commit it
- [x] Retrieval + template answer with citations
- [x] Point `/ask` at the ML service
- [ ] (Optional) local rephrasing generator behind a flag (skipped by decision -- the extractive path is the deliverable, and a generator adds CPU latency without adding traceability)

---

## Metrics

This is what the evaluation actually wanted. Build a test set **first**, not last.

| Metric | Target of measurement |
|---|---|
| OCR field-extraction accuracy | per-field: name / dosage / expiry, on a held-out set of real medicine box photos |
| Medicine-name matching | top-1 and top-5 accuracy against `medicines.db` |
| TrOCR CER | character error rate **before vs after** fine-tuning |
| Retrieval quality | Recall@k (k = 1, 3, 5) for the assistant |

**Ablation study** (this is the "measurable ML work"):
- Tesseract vs PaddleOCR on the same box photos
- raw OCR output vs lexicon-constrained matching
- `trocr-small-handwritten` off-the-shelf vs fine-tuned

**Deliverable artifacts:** the curated medicine dataset, the fine-tuned TrOCR checkpoint,
the ablation tables, and the Colab training notebook.

- [ ] Photograph/collect ~100 medicine boxes, hand-label name/dosage/expiry → test set
- [ ] Evaluation script that prints all four metric tables
- [ ] Run the three ablations, save results

---

## Build order and effort

| # | Work | Effort | Why this order |
|---|---|---|---|
| 1 | AI assistant RAG (`/ask`) | ~1 week | Low risk, fully deployable, no dataset collection blocking it |
| 2 | Packaging + expiry OCR + medicine DB | ~1 week | Low risk, and the DB unblocks Feature 2 |
| 3 | Handwritten prescription fine-tuning | ~2 weeks | Highest risk, do it with the rest already shipped |

Steps 1 and 2 together **remove Gemini from 3 of the 4 call sites** (`/ask`, `/ocr:expiry`,
`/ocr:packaging`) and are enough to demo a working, Gemini-free app.

Step 3 is the only piece that may need **scope negotiation with the college** — if handwritten
accuracy is not good enough, the fallback position is: printed prescriptions fully automated,
handwritten via the confirm/edit screen, with the CER numbers reported honestly.

---

## Open risks

- **HF Spaces cold start (~30s)** — mitigated by keep-alive + loading state, but it will be
  visible in a live demo. Ping the Space before the demo starts.
- **Free-tier CPU latency** — PaddleOCR ~1–2s is fine; TrOCR on many word crops may not be.
  Cap the number of crops per prescription, or batch them.
- **Handwritten accuracy** — the real risk. Ties directly to the scope negotiation above.
- **Medicine DB coverage** — if CDSCO data is messy or hard to scrape, name matching degrades
  everywhere (it feeds Features 1 and 2). Validate the dataset early, in week 1.
- **HF Spaces free tier availability** — if the Space becomes unreliable, fallbacks are
  Fly.io free tier or a Render paid instance. Don't design anything that assumes HF specifically.
- **Test set labeling effort** — 100 hand-labeled photos is real work. Start collecting on day 1,
  in parallel with everything else.
