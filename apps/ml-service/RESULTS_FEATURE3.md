# Feature 3 — Retrieval results

Measured numbers for the assistant's RAG retrieval stage. Every figure below comes from an
actual run of the two scripts in `scripts/`; nothing here is estimated or extrapolated.

Measured on 2026-08-24 against index build `2026-08-24T04:01:35Z`.

## Reproducing

Run from `apps/ml-service`, using the project venv interpreter (not global Python), so that
`app.` and `scripts.` imports resolve:

```
cd D:\PDD\mediguard\apps\ml-service
.venv\Scripts\python.exe scripts\evaluate.py --retrieval
.venv\Scripts\python.exe scripts\ablation.py --retrieval
```

Both are offline — they load the index directly and do not need the FastAPI service running.
Each invocation loads `all-MiniLM-L6-v2` and the full index first, so expect roughly a minute
of startup before any table prints; the alpha sweep then runs the query set six times.

## What was measured

**Recall@k on paraphrased questions.** `data/testset/queries.jsonl` holds 44 hand-written
questions, each labelled with the curated FAQ entry that should answer it. A query counts as a
hit at *k* if the corpus chunk carrying that FAQ appears in the top *k* retrieved chunks. This
is a retrieval metric only — it scores which passages come back, not the wording of the final
answer.

The 44 questions cover all 35 curated FAQ chunks, at 1–2 questions per chunk.

## Corpus and index

Counted directly from `data/corpus.jsonl` (`source` field) rather than taken on trust:

| Source | Chunks | Share |
| --- | ---: | ---: |
| openFDA drug label | 10,432 | 96.7% |
| MedlinePlus (NLM) | 322 | 3.0% |
| MediGuard curated FAQ | 35 | 0.3% |
| **Total** | **10,789** | 100% |

Chunk length: median 238 words, mean 186, p95 279, max 1331.

`data/index/manifest.json`:

```json
{
  "chunks": 10789,
  "dim": 384,
  "model": "all-MiniLM-L6-v2",
  "build_seconds": 356.7,
  "built_at": "2026-08-24T04:01:35Z"
}
```

The manifest's chunk count matches the corpus line count exactly (10,789), so the index is in
sync with the corpus it was built from. Dense search runs on FAISS `IndexFlatIP` (faiss 1.10.0
is installed in the venv); `app/assistant/index.py` falls back to an exact numpy dot product if
faiss is unavailable, which is the same result either way at this corpus size. The lexical half
is a word-level TF-IDF matrix in `data/index/tfidf.pkl`.

## Recall@k

Verbatim output of `scripts/evaluate.py --retrieval`:

```
Retrieval Recall@k (n=44 paraphrased questions)
-----------------------------------------------
configuration        Recall@1       Recall@3       Recall@5
-------------------  -------------  -------------  -------------
hybrid (alpha=0.75)  72.7% (32/44)  84.1% (37/44)  88.6% (39/44)
dense only           75.0% (33/44)  84.1% (37/44)  88.6% (39/44)
lexical only         22.7% (10/44)  27.3% (12/44)  36.4% (16/44)
```

`alpha=0.75` is the shipped default (`ALPHA` in `app/assistant/retriever.py`). The service
retrieves `TOP_K = 4` chunks at a `MIN_SCORE = 0.25` floor, so Recall@3 is the figure closest
to what the assistant actually sees in production.

## Fusion weight sweep

Verbatim output of `scripts/ablation.py --retrieval`. Alpha is the weight on the dense score;
`1 - alpha` is the weight on TF-IDF.

```
Ablation 2 -- retrieval fusion weight (n=44 questions)
------------------------------------------------------
alpha (dense weight)  Recall@1       Recall@3       Recall@5
--------------------  -------------  -------------  -------------
0.00 (lexical only)   22.7% (10/44)  27.3% (12/44)  36.4% (16/44)
0.25                  40.9% (18/44)  70.5% (31/44)  77.3% (34/44)
0.50                  56.8% (25/44)  77.3% (34/44)  84.1% (37/44)
0.75                  72.7% (32/44)  84.1% (37/44)  88.6% (39/44)
0.90                  79.5% (35/44)  84.1% (37/44)  88.6% (39/44)
1.00 (dense only)     75.0% (33/44)  84.1% (37/44)  88.6% (39/44)
```

### Interpretation

**Dense retrieval does the work.** Recall@1 climbs monotonically from 22.7% to 79.5% as alpha
goes from 0.0 to 0.9. Lexical-only retrieval is close to useless on this set — 22.7% @1, and
even at k=5 it only finds 36.4% of targets. That is the expected result: the questions are
deliberate paraphrases ("my paracetamol expired last month, can I still take it?" against
"Is it safe to take medicine after the expiry date?"), and word overlap is exactly what
paraphrasing destroys.

**Hybrid beats dense-only, but only barely and only at rank 1.** The peak is alpha=0.90 at
79.5% Recall@1, which is +4.5 points over dense-only. At k=3 and k=5, every configuration from
alpha=0.75 upward is identical (84.1% / 88.6%) — the lexical signal reorders the top of the
list without pulling in any chunk dense retrieval had missed entirely.

**The shipped alpha=0.75 is not the optimum on this set.** It scores 72.7% @1, below both
alpha=0.90 (79.5%) and dense-only (75.0%). It ties everything above it at k=3 and k=5.

**These gaps are within noise.** With n=44, one query is worth 2.3 points. The 0.90-vs-1.00
gap at Recall@1 is two queries; the 0.75-vs-1.00 gap is one. This test set cannot support a
claim that any of 0.75, 0.90, or 1.00 is genuinely better than the others at rank 1 — it can
only support the strong claim that dense-dominant beats lexical-dominant, which the low-alpha
rows establish with a very large margin.

The honest reading is that the lexical half is not justified by *this* test set. The argument
for keeping it is a different one: the set contains no drug-name queries ("side effects of
metformin"), where exact-token matching on a rare name is what separates the right drug's label
from a semantically similar wrong one. That argument is untested here.

## Limitations

These are the things to state up front rather than be caught on.

1. **The test set is small: 44 queries.** One query moves any percentage by 2.3 points. No
   difference smaller than about 3 queries in this document is meaningful.

2. **This measures FAQ-routing recall, not corpus-wide retrieval quality.** Every query is
   labelled against one of the 35 curated FAQ chunks — 0.3% of the corpus. The remaining 99.7%
   (10,432 openFDA label chunks and 322 MedlinePlus chunks) is never a correct answer in this
   evaluation, only a distractor. So the numbers say "the retriever routes a paraphrased
   consumer question to the right curated FAQ 84.1% of the time in the top 3." They do **not**
   say the retriever finds the right openFDA drug-label passage 84.1% of the time. That second
   claim is unmeasured.

3. **The curated FAQ targets are short and self-contained,** which favours dense retrieval and
   likely inflates the alpha sweep's tilt toward high alpha. A drug-name query set would
   probably shift the optimum downward. This is a stated hypothesis, not a measured result.

4. **The queries and the FAQ answers were written by the same author,** so there is a shared
   vocabulary and framing that an independent user's phrasing would not have. Treat these as an
   upper bound on real-world routing accuracy.

5. **Retrieval only.** Nothing here evaluates the composed answer — whether the extracted
   sentences actually answer the question, or whether the citations are the right ones. That
   would need a separate answer-quality judgement, which has not been done.

Closing the biggest gap (#2) means labelling a query set against openFDA label chunks —
questions whose correct target is a specific drug's Adverse Reactions or Interactions section.
That set does not exist yet.
