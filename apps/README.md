# Applications

The four runtime components PRD 10 describes. Each is wiring, transport and configuration over
`packages/composition`; none imports another, and `boundaries:check` enforces that rather than this
paragraph.

## Running them

From the repository root:

```bash
pnpm app:ingest     # crawl examples/corpus and report
pnpm app:api        # answer API on http://127.0.0.1:8080
pnpm app:eval       # run every ablation arm, write evidence/
pnpm app:console    # read-only console on http://127.0.0.1:8081
```

Ask the API a question:

```bash
curl -s localhost:8080/answer \
  -H 'content-type: application/json' \
  -d '{"query":"refund window","principal":"prn_reader"}'
```

## What is not installed, and what follows from it

**No provider adapter exists.** PRD 5 puts embedding, reranking and generation behind
`model-gateway`'s interfaces, and this repository implements the interfaces and the deterministic
in-repo stand-ins — not an adapter for any vendor. Every model identifier these processes record
says so: `stand-in-embedder`, `stand-in-reranker`, `stand-in-not-a-model`.

Two consequences worth stating before somebody runs this and draws a conclusion:

- **The embedder has no semantic structure.** It derives a vector from a hash, so cosine similarity
  between an unrelated query and a passage is noise rather than zero. The dense arm therefore
  returns candidates for a query the corpus cannot answer, and the API answers almost anything with
  something. Nothing these processes produce is evidence about retrieval quality.
- **The generator does no language modelling.** It cites the first passage it was shown and quotes
  its opening. That exercises prompt assembly, citation binding and the verification pass for real
  — which is the part worth exercising — and produces prose nobody should read as an answer.

**No persistent storage adapter exists either.** The only store profile is `memory`, which is
in-process. Four components in four processes therefore cannot share a corpus, which is why
`app:api` and `app:eval` crawl a corpus themselves at startup rather than reading one the worker
wrote. PRD 10 has these components communicating through the corpus store and the indexes; with a
persistent profile they would, and the composition root would not change. Both applications refuse
any other profile by name rather than falling back, because a deployment that quietly forgets its
corpus is worse than one that will not start.

## Configuration

| Variable                           | Used by             | Default       | Meaning                                                    |
| ---------------------------------- | ------------------- | ------------- | ---------------------------------------------------------- |
| `ATLASOPS_PORT`                    | api                 | `8080`        | Listen port.                                               |
| `ATLASOPS_CONSOLE_PORT`            | console             | `8081`        | Listen port.                                               |
| `ATLASOPS_STORE`                   | api, worker         | `memory`      | Store profile. Only `memory` is implemented.               |
| `ATLASOPS_GENERATOR`               | api                 | `stand-in`    | Generator. Only `stand-in` is implemented.                 |
| `ATLASOPS_CORPUS_ROOT`             | all but console     | —             | Directory to crawl. Required by the worker and the runner. |
| `ATLASOPS_CORPUS_GROUP`            | api, worker, runner | `engineering` | The group the corpus is labelled with.                     |
| `ATLASOPS_CHUNK_TOKENS`            | worker              | `256`         | Chunk budget. PRD 4.3 makes this a per-connector decision. |
| `ATLASOPS_DATASETS`                | runner              | —             | Path to a datasets JSON file.                              |
| `ATLASOPS_EVIDENCE_DIR`            | runner, console     | `evidence`    | Where artefacts are written and read.                      |
| `ATLASOPS_ALLOW_SNAPSHOT_MISMATCH` | runner              | unset         | `1` to run datasets labelled against another corpus.       |

That last one deserves its own note. PRD 8.1 names re-ingesting the corpus as one of the two most
effective ways to fake an improvement, so the runner refuses by default when a dataset's corpus
snapshot is not the corpus it just built. The in-repo fixture datasets are labelled against no
corpus at all — they exist to exercise the metrics — so `pnpm app:eval` sets the flag, and every
artefact it writes says on its face that the numbers are not comparable to a run whose snapshot
matched.
