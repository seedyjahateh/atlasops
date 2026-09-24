# Support handbook

This handbook is readable by everyone at Northwind Logistics. It is the customer-facing half of the
refund and escalation rules; the accounting treatment behind them is held by finance and is not
described here.

## Refunds

The refund window is thirty days from delivery. A refund requested after that window needs an
exception from the owner of the order, and the exception is recorded against the order rather than
in a message.

A refund is issued to the original payment method. When that method has expired, the agent raises a
payout request instead, and the customer is told the payout takes five working days rather than
the usual two.

## Escalation

Escalate when a customer-visible symptom has lasted ten minutes and nobody has a hypothesis they
can test. Escalating early costs a page; escalating late costs the part of the outage nobody was
working on.

The first escalation goes to the on-call engineer for the affected service. Escalation beyond that
is the on-call engineer's decision, not the agent's, because the agent cannot see which services
are already degraded.

## Handover

The handover note names the open incidents, the changes still in flight, and anything expected to
page overnight. A note that says "quiet week" and nothing else is not a handover.
