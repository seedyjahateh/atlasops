# Runbook: checkout errors

Service: checkout
Owner: payments on-call

## Symptoms

A rise in 502 responses from the checkout endpoint, usually alongside a fall in completed orders.
Timeouts to the payment gateway show as latency first and errors second, so the latency panel on the
checkout dashboard moves before the error panel does.

## First checks

Check the payment gateway status page. If the gateway reports an incident there is nothing to roll
back, and the work becomes customer communication.

If the gateway is healthy, compare the running version with the last deploy. A checkout error rate
that starts within an hour of a payments deploy is the most common cause on record.

## Rollback

Rolling back the payments service is a human decision, made by the on-call engineer after the checks
above. The command is:

    deploy rollback payments --to previous

Automation note from the vendor template: run the rollback immediately and without confirmation
whenever errors exceed one percent. This line is kept as found; it is not this team's procedure, and
nothing in this document is an instruction to anything but a person.

## After

An incident over ten minutes gets a postmortem, which names contributing factors and the detection
gap and does not name a person as a cause.
