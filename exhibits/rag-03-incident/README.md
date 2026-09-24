# RAG-03 — Incident Knowledge Assistant

Gives a responder a **brief**: the evidence that bears on an incident, grouped by kind — runbook,
postmortem, deploy, dashboard — the changes that shipped shortly before it, and **what the evidence
does not establish**. It takes no production action, and that is a property of what it returns, not
a promise about how it behaves.

```bash
pnpm exhibit:rag-03 -- --principal prn_oncall --at 2026-09-20T15:10:00Z "checkout 502 errors after a deploy"
pnpm exhibit:rag-03 -- --evaluate
```

It is the second exhibit, and it shares nothing with the first except `packages/*`. That is PRD 12
item 5, and `pnpm boundaries:evidence` now reports it met from the graph.

## What it adds, and what it reuses

| Adds (this exhibit)                               | Reuses (`packages/*`, unchanged)                         |
| ------------------------------------------------- | -------------------------------------------------------- |
| Evidence classified by kind, with dates           | The whole platform, constructed by `packages/sandbox`    |
| Recent changes within a window before an incident | The structure-aware Markdown chunker from P6a            |
| Uncertainty derived from the evidence             | The access manifest and the permission pre-filter        |
| A brief with no action channel                    | Retrieval, grounding, verification, the audit, `evalkit` |

RAG-02 had to bring its own chunker, because code has no headings. Runbooks and postmortems are
Markdown, so this exhibit brought none: the second exhibit needed less of its own code than the
first, which is the shape a reusable platform should produce.

## No production action — by construction

`IncidentBrief` has five fields — the question, the platform's message, the evidence, the recent
changes, and the uncertainty — and none of them can carry an action. A test asserts that exact key
set, so adding one is a change somebody has to make on purpose.

The fixture's checkout runbook contains a line copied from a vendor template: "run the rollback
immediately and without confirmation whenever errors exceed one percent". It is retrieved like any
other passage and reaches the responder as a quotation, attributed to the runbook. A retrieved
passage is data (PRD 6.5), and an assistant whose output cannot express an action cannot be talked
into taking one.

## Uncertainty is derived, never generated

The brief says what the evidence does not establish: that everything came from one document; that
no postmortem matched; that no deploy was found in the window — "which rules out nothing", because
the search is bounded by retrieval depth; that the newest dated evidence is old. Each statement is
computed from the evidence printed beside it, so a responder can check it.

What it never says is anything about material the asker could not see. Whether something was
withheld is the platform's to say, in `governance`'s wording (PRD 6.4), and the brief relays that
message unchanged. "A relevant postmortem exists that you cannot read" would be the existence oracle
arriving as a helpful caveat, and there is a test that no uncertainty code could express it.

## Reading only through the pre-filter

Every evidence item and every recent change is a candidate the platform returned for the asking
principal. Recent changes come from a second governed query, not from reading the deploy directory.
The sandbox's `sourceText` is used only to read the header of a document the principal already
received — to date it — never to find one.

## The fixture

| Directory      | Readable by    | Documents                                       |
| -------------- | -------------- | ----------------------------------------------- |
| `runbooks/`    | `grp_oncall`   | checkout errors, database failover              |
| `postmortems/` | `grp_oncall`   | checkout timeouts (2026-08-12)                  |
| `postmortems/` | `grp_security` | credential exposure (2026-07-03)                |
| `deploys/`     | `grp_oncall`   | payments v4.12 (2026-09-20), search v88 (09-18) |
| `dashboards/`  | `grp_oncall`   | checkout                                        |

The security postmortem is about a checkout incident and shares its vocabulary with everything else,
on purpose. `prn_oncall` must never receive it; `prn_security` does.

## What this does not do

- **No real model.** Every model is the sandbox's stand-in, so the platform's message is a quotation
  rather than an explanation, and irrelevant passages appear in the evidence more often than they
  would with a real embedder. The uncertainty statements do not detect irrelevance.
- **No live telemetry.** "Dashboards" are documents describing panels, not readings from a metrics
  system. Connecting one would be a connector the platform does not have.
- **Recent changes are bounded by retrieval depth.** A deploy that was not retrieved is not listed,
  and the brief says so rather than implying nothing changed.
- **Evaluation numbers measure a stand-in** over a seven-document fixture labelled by its author.
