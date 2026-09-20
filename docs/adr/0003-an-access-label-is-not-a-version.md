# ADR 0003 — An access label is not a version

- **Status:** accepted
- **Phase:** P5 (`packages/corpus`)
- **Specification:** PRD 4.1, 4.2, 4.4, 6.1

## Context

P1 made a source version's identity the hash of its bytes, and `parseSourceVersion` enforces it:
a record whose `sourceVersionId` is not derived from its `contentHash` fails to parse. That is what
makes re-ingestion idempotent and rollback a pointer move, and it is not in question here.

P1 also put the ACL label on `SourceVersion`, because PRD 4.4 requires every chunk to carry one and
a chunk belongs to a version.

Those two decisions collide the first time a document's permissions change without its content
changing — which is not an edge case. A folder is re-shared, a group is renamed, an employee
leaves a team. The bytes are identical, so the version identifier is identical, so there is no new
version to carry the new label. The only ways out are to mutate the stored record, which destroys
the immutability the whole versioning argument rests on, or to leave the label stale, which means a
revocation does not take effect until somebody edits the document.

## Decision

**The label has its own log, and the live read path re-labels.**

- The frozen `SourceVersion` record keeps the label that was resolved when those bytes first
  arrived. It is never rewritten.
- The source carries an `aclLog`: a list of label revisions with the instant each took effect.
- `store.liveVersion()` and `store.append()` return the head record with the _current_ label
  substituted. `state().versions` returns the frozen records, unmodified, for audit.
- `versionAsOf()` returns the record with the label that was in force at the requested instant,
  and is documented as an audit and evaluation path that must never be used to authorise a live
  request.
- Deletion writes a deny-all label, and reinstatement does not restore the previous one — a
  connector has to resolve a label again before anything is readable.

## Consequences

A permission change takes effect immediately and costs no version, no re-parse and no re-embedding.
That is the property PRD 6.1 needs: the answer to "how long after revocation can this still be
read" is "it cannot", rather than a number nobody chose.

The cost is that `version.acl` means two different things depending on where the record came from.
A frozen record's label is historical; a live record's label is current. This is mitigated by
making the live path the only convenient one — `liveVersion` is what the layers above call, and
`state().versions` is named like the archive it is — but it is a real sharp edge and it is the
reason this is an ADR rather than a comment.

## The deduplication hazard this exposes

Working through the above surfaced a second consequence of content-addressed identity that is worth
recording before a later phase trips over it.

A version identifier is the hash of the bytes **and nothing else**, so two different sources holding
byte-identical content produce the same `sourceVersionId` — and therefore the same chunk
identifiers, since `formatChunkId` derives from the version and the ordinal. If those two sources
sit in different ACL zones, anything that deduplicates by chunk identifier merges content across a
permission boundary. That is a leak, arriving through an optimisation rather than through the
authorisation path anybody would think to audit.

This is not fixed here, because changing the identifier scheme reverses P1 and would ripple through
every layer that already depends on it. What is done here instead:

- **`packages/corpus` never keys versions globally.** Every lookup and every reference out of this
  package is a `VersionRef` carrying the source as well as the version, so within the corpus the
  collision cannot be reached.
- **`ingest` (P6) and `indexing` (P7) must not deduplicate chunks across sources whose labels
  differ.** Recorded here so that the constraint arrives before the code that would break it, and
  so that a later decision to change the identifier scheme has this written down as its reason.
