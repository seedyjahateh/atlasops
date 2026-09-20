# ADR 0001 - The generated module table lives in docs/MODULES.md, not in the PRD

- Status: accepted
- Date: 2026-09-20
- Phase: P0

## Context

PRD 11.3 mechanism 2 says the layer manifest is the single source of truth and that "the table
above is generated from it and CI fails if the generated table differs from the committed one". The
table it refers to is in PRD 11.2, inside `docs/prd/RAG-01-atlasops.md`.

That document is a **mirror**. Its canonical copy lives in the portfolio repository at
`docs/prd/projects/RAG-01-atlasops.md`, and the portfolio copy wins on disagreement — the same rule
the archive applies to project manifests.

A generator that rewrote the mirror would put the two copies into conflict on its first run: the
mirror would gain a regenerated table, the canonical copy would not, and the next person to sync
them would have to decide which difference was intentional. Worse, it would mean this repository's
CI could fail because of the _portfolio's_ formatting, which is a dependency in the wrong
direction — the build repository should not be able to be broken by an editorial edit elsewhere.

## Decision

Generate `docs/MODULES.md` in this repository from `tools/boundaries/layers.json`, and have
`pnpm boundaries:check` fail when the committed copy differs from what the manifest produces.

Leave the PRD's own section 11.2 table as prose, owned by the canonical copy in the portfolio.

## Consequences

Easier: the generated artefact and the mirrored specification have separate owners, so neither can
break the other. `docs/MODULES.md` is small, diffable, and unambiguous about being generated —
it carries a do-not-edit notice and is in `.prettierignore` so that Prettier and the generator do
not fight over table alignment.

Harder: there are now two tables describing the same boundaries — the PRD's prose one and the
generated one. They can drift. The generated one is authoritative because it is derived from the
file the checker actually enforces; the PRD's is the argument for why the boundaries are what they
are. If they disagree, the PRD is describing an intent that the manifest did not implement, and
that is a real finding rather than a formatting nuisance.

This is a deviation from the literal wording of PRD 11.3 and is recorded here rather than made
silently.

## Compressed cost

None - build-time only. `docs/MODULES.md` ships to no route.

## Fallback

If the generator is unavailable, `boundaries:check` fails closed: a missing `docs/MODULES.md` is
reported as an error rather than skipped.

## Removal path

Delete `tools/boundaries/src/table.ts`, the `boundaries:table` script, the table comparison in
`cli.ts`, and `docs/MODULES.md`. The enforcement in `check.ts` is independent of it and keeps
working; what is lost is the human-readable view of the manifest.

## Revisit trigger

If the PRD stops being mirrored here — or if the portfolio adopts a mechanism for generating
project documents from build repositories — the reason for the split disappears and the table
should move back into the specification.
