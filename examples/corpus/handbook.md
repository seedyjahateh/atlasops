# Engineering handbook

This is the example corpus the documented commands crawl. It is small on purpose: it exists so the
four components in PRD 10 can be started and seen to work, not to measure anything.

## Refunds

The refund window is thirty days from delivery. A refund requested after that window needs an
exception from the owner of the order, and the exception is recorded against the order rather than
in a message.

## Escalation

Escalate when a customer-visible symptom has lasted ten minutes and nobody has a hypothesis they
can test. Escalating early costs a page; escalating late costs the part of the outage nobody was
working on.

## Handover

The handover note names the open incidents, the changes still in flight, and anything expected to
page overnight. A note that says "quiet week" and nothing else is not a handover.
