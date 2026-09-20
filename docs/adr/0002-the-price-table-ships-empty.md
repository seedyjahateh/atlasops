# ADR 0002 - The price table ships empty, and an unpriced model is an error

- Status: accepted
- Date: 2026-09-20
- Phase: P2

## Context

PRD 9.2 requires cost to be "computed per request from token counts and a checked-in, versioned
price table — not read back from a provider dashboard, because a cost figure that cannot be
attributed to a request cannot be acted on."

That mechanism is what P2 builds. The data it needs is a different matter: real per-token prices
for real models are facts about vendor pricing, and PRD section 0 forbids inventing figures. A
plausible-looking table of made-up prices would be worse than no table, because every cost number
the system produced afterwards would be fabricated and would look measured.

There is a second question hiding behind the first. When a model has no entry, the obvious
implementation returns zero and carries on.

## Decision

Ship `prices/` with a single table at version `0-unpriced` containing no models, and make
`costOf` **throw** `BUDGET_EXCEEDED`-adjacent failure — specifically an `AtlasOpsError` — when
asked to price a model the table does not list.

Tests use an explicitly synthetic fixture table, named as such, so no test depends on a real price.

Populating the table with real prices is a data task with a date and a source, performed when the
models are actually chosen, and it changes `version`.

## Consequences

Easier: no fabricated number can enter the system through this door. A cost report is either
computed from prices somebody recorded deliberately, or it does not exist. The table's `version`
is stamped into every cost record, so a report can always be traced to the prices that produced it.

Harder: nothing can compute cost until the table is populated. That is the intended pressure — a
system that silently reports $0.00 for an unpriced model satisfies every test and misleads every
reader of the cost budget in PRD 9.3.

The rejected alternative was defaulting to zero for unknown models. It fails silently and in the
dangerous direction: cost budgets would pass trivially, and the failure would only surface on a
vendor invoice.

## Compressed cost

None - build-time and runtime accounting only. Nothing ships to a route.

## Fallback

There is none by design. An unpriced model stops cost accounting rather than degrading it; the
caller decides whether to proceed without a cost figure or to stop.

## Removal path

Populate `prices/` with real prices and a new `version`. No code changes; the throw becomes
unreachable for listed models.

## Revisit trigger

The first time a real model identifier is pinned for the reference profile in PRD 9.1. At that
point the table has a concrete job and this ADR's premise expires.
