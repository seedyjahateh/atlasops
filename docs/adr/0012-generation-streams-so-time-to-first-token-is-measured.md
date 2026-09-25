# ADR 0012 — Generation streams, so time to first token is measured

- **Status:** accepted
- **Date:** 2026-09-25
- **Amends:** ADR 0006, which used the non-streaming endpoint, leaving PRD 9.3's time-to-first-token
  budget unmeasurable

## Context

PRD 9.3 sets a budget of 1,200 ms for time to first token at p95, measured by "streaming
instrumentation on the same run". The OpenAI adapter spoke the non-streaming endpoint (ADR 0006), so
every load run reported the budget as unmeasured. A whole-response latency is not a first-token time
and was never substituted for one.

When the served configuration changed (ADR 0011), the end-to-end budget was breached and accepted,
and that acceptance named streaming as "the fix for perceived latency". **That was wrong for this
system.** PRD 7.2 requires verification before an answer is returned. The answer is a structure,
and its citations cannot be checked until the whole thing exists, so no token can reach a caller
before the answer is complete and verified. Streaming cannot make an answer feel faster here without
breaking PRD 7.2. What it can do is measure how long the model takes to start.

## Decision

1. **The OpenAI generator streams.** `openAiGenerator({ stream: true })` requests
   `stream: true` with `stream_options: { include_usage: true }`, reads the server-sent events, and
   records the milliseconds to the first _content_ token and to the end of the response. The opening
   event that only announces the assistant role carries no content and is not timed; timing it would
   measure the connection. `openAiModelSet` turns streaming on.
2. **The caller still receives the whole answer, once.** `generate()` returns the assembled text,
   exactly as before. Grounding parses, verifies and releases it as before.
3. **The same failure rules hold.** A stream cut off before a finish reason is refused. So is one
   that hits the output limit, or one with no usage record, which cannot be priced. An error event
   inside the stream is a `ModelError` with the key redacted. A non-2xx response is classified
   exactly like a whole one, including the provider's requested wait.
4. **The transport gained an optional `stream` method.** `fetchTransport` reads the body as it
   arrives, under the same deadline, which now covers the whole stream. `recordingTransport` replays
   recorded chunks, which tests split mid-line on purpose, because the network does. A generator
   asked to stream over a transport that cannot is refused at construction, so a load run meant to
   measure time to first token cannot silently measure nothing.
5. **Grounding places the first token on its own clock.** `GroundingResult.firstTokenAtMs` is worked
   back from when the call returned, using the adapter's response time for the successful attempt,
   so retry waits cannot pull it earlier than it was. It is null when nothing streamed. Composition
   now passes its clock into grounding; grounding used to fall back to the system clock, which
   agreed with the caller's clock only by coincidence.
6. **The load harness measures it from the start of each request**, over the requests that streamed
   a first token. Abstentions before generation and degraded requests have no first token and are
   not counted as zero. The budget row carries a caveat saying nothing reached the caller then.

## Consequences

- PRD 9.3's time-to-first-token budget is measured for the first time. The figure means "the model
  started", not "the user saw something", and every artefact that shows it says so.
- The perceived latency of long answers is unchanged. Improving it would need a different contract:
  streaming verified segments one at a time, or releasing text marked unverified. Either is a change
  to PRD 7, not an implementation detail, and neither is made here.
- Streaming is on only for the OpenAI set. The stand-ins return whole answers and report no first
  token, which the load run states instead of reporting zero.
