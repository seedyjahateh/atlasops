# The evaluation corpus: how it was built

PRD 13 names the first risk of this project plainly: "the evaluation corpus is synthetic, so metrics
measure the corpus as much as the system", and its mitigation is to **publish the corpus
construction procedure**. This is that document. It describes `examples/corpus`, which is the corpus
every command in this repository runs against and the one the datasets in P14b are labelled for.

## What it is, and what it is not

Eight Markdown documents, 35 chunks, about a fictional logistics company. Every word of it was
written for this repository. There is no real user data in it, no real company, and no document
that came from anywhere else.

That is a limitation before it is anything else, and it is the one in `docs/limitations.md` that
travels furthest: a retrieval score over this corpus is a statement about eight documents somebody
wrote knowing what would be asked of them. It is not a statement about how the system behaves over
a real knowledge base, and no artefact generated from it may be read as one.

What it can support is narrower and real: whether the permission pre-filter holds, whether an
answer cites what it used, whether the system abstains when it should. Those are properties of the
code, and a small corpus exercises them as well as a large one.

## The zones, and why there are four

| Zone           | Group             | Existence | Documents                         |
| -------------- | ----------------- | --------- | --------------------------------- |
| `public/`      | `grp_everyone`    | visible   | handbook, retention, vendor brief |
| `engineering/` | `grp_engineering` | visible   | checkout runbook, on-call         |
| `finance/`     | `grp_finance`     | visible   | quarter close, refund reserve     |
| `restricted/`  | `grp_exec`        | hidden    | Project Harbour                   |

A corpus with one zone cannot test the thing this project is about. Every permission metric over it
is zero because nothing is forbidden, and a leak count of zero would be arithmetic rather than
evidence — which is why `filesystemConnector` gained a per-path resolver in P14a rather than P14b
discovering the problem at labelling time.

The four zones are not decorative:

- **`finance/` exists to be forbidden to the principal who asks the most natural questions.**
  `prn_alice` is engineering. The finance documents deliberately reuse the support handbook's
  vocabulary — "refund", "window", "exception" — so a question she is entitled to ask has something
  tempting and forbidden sitting beside the answer she should get. A corpus whose zones share no
  vocabulary makes the pre-filter look better than it is, because lexical mismatch does the work
  the permission filter is supposed to do.
- **`restricted/` is hidden rather than merely restricted**, which is the distinction PRD 6.4 turns
  into a rule. A restricted document may be known to exist; here the name is the secret, so the
  answer to "do we have anything on Harbour" has to be byte-identical to the answer given when
  nothing was found at all.
- **`public/vendor-brief.md` carries the prompt-injection passages** PRD 6.5 requires a corpus to
  contain. They are quoted vendor material, they say what injection text says, and they are
  deliberately not paraphrased into something harmless. The defence being exercised is structural —
  a passage cannot close its own prompt block, and an answer citing a chunk the model was never
  shown fails verification — so a corpus containing only polite passages would test nothing.

## Who wrote it

I did, in one pass, as the author of this repository. Nobody else has reviewed the documents for
realism, and no domain expert has read them. Where a document states a policy — a thirty-day refund
window, a seven-year retention period — the number is plausible and invented, and nothing anywhere
in this repository treats those numbers as facts about the world.

## The labels

`examples/corpus.datasets.json`, added in P14b: 14 graded relevance items, 7 grounded answers, 7
abstention cases and 7 permission probes, all pinned to the snapshot above.

**Who labelled them.** I did, the same afternoon I wrote the documents, with no second reader. That
is the single most important caveat on every retrieval number this repository produces: the person
who wrote the corpus also decided which passage answers which question, and both were done knowing
what the system does. It is not an independent judgment and no amount of method fixes that.

**The grading scale**, applied to each chunk for the query _and the principal_ named on the item:

| Grade | Meaning                                                                      |
| ----- | ---------------------------------------------------------------------------- |
| 3     | Answers the question on its own. A reader could stop here.                   |
| 2     | Substantially useful — a necessary part of a complete answer, but not alone. |
| 1     | Related context: names the topic, does not answer it.                        |
| 0     | Irrelevant. Written as an omission rather than an explicit zero.             |

Graded rather than binary because PRD 8.2 asks for nDCG, and nDCG over binary labels cannot tell a
run that put the definitive passage first from one that put a passing mention there — which is most
of what reranking is for.

**Labels are per principal, and never cross a zone.** A relevance judgment names a principal, and
every chunk it grades above zero is one that principal may read. The mirror rule holds for probes:
every chunk listed as forbidden is one the principal genuinely cannot read. Both are enforced by
`pnpm datasets:check` rather than trusted, because both mistakes are invisible downstream — a label
on unreadable material asks the system to leak and scores the pre-filter as a miss, and a probe that
forbids readable material turns an ordinary retrieval into a leak and invites somebody to loosen the
gate.

**Adversarial subpopulations**, per PRD 8.1: `lexical-distractor` (the word appears in a document
that does not answer the question — "escalation" is in the handbook, the on-call policy and the
vendor brief, meaning three different things), `cross-zone-vocabulary` (the answer spans the public
and finance zones for a finance principal, and stops at the public zone for everybody else), and
`multi-passage` (no single chunk suffices).

**What `humanJudgement` means here**, since it is ambiguous and PRD 8.3 leans on it: on the items
that carry it, it records _my_ verdict that a correct answer to that question is supported by the
cited passages and contradicts nothing in them. It is not a judgment of any particular answer the
system produced, because no answer exists until a run happens. Judge-human agreement computed
against a stand-in generator is therefore a measure of the stand-in, not a calibration of a judge.

**The held-out split is 3 relevance items, 1 grounded answer and 1 probe.** `pnpm app:eval` reads
development only; reading held-out needs `--final "<reason>"`, and the reason is printed in the
artefact. That default arrived in P14b — before it, the routine run read the held-out split every
time, and the seal was a comment.

## What the first labelled run found

Recorded here because it is a finding about the system rather than about the corpus, and because it
is the kind of number that is tempting to leave in an artefact nobody re-reads: **correct-abstention
was 0 over 4 development cases**. The system answered every question it should have refused.

That is a truthful measurement of what is wired today, and it is not a surprise: with a stand-in
embedder every passage looks equally relevant, so the support threshold PRD 7.3 defines never
decides anything. It says nothing about whether abstention would work with a real model, and it is
exactly the row that would have read as "0.0 — fine" if nobody looked.

## How it is pinned

`examples/corpus.inventory.json` records every source, its zone, and every chunk identifier the
corpus produces, with each chunk's offsets and opening words. It is generated by
`pnpm corpus:inventory` and checked by `pnpm corpus:check`, which runs inside `pnpm verify`.

The check exists because chunk identifiers are derived from a source version and an ordinal.
Editing a document moves them, and nothing would break loudly: the labels pointing into that
document would reference chunks that no longer exist, every metric would still compute, and the
numbers would quietly describe a smaller corpus. The failure mode this repository is most concerned
with is the one that leaves the build green.

The snapshot hash in the inventory is produced by `corpusSnapshotOf` in `@atlasops/composition` —
the same function `apps/eval-runner` calls before it checks a dataset's pin. One function rather
than two, because two implementations agree until they do not, and the resulting mismatch would be
a dataset pin nobody could explain.

## Changing the corpus

1. Add or edit the document.
2. Add a rule to `examples/corpus.acl.json` if the path is new. There is no default label: a path
   no rule covers fails its own fetch with `ACL_UNRESOLVED`, and the crawl continues without it.
3. Run `pnpm corpus:inventory` and commit the result.
4. **Re-check every label that pointed into the document you touched.** The inventory check will
   tell you the corpus moved; it cannot tell you whether a judgment about a chunk is still right.
