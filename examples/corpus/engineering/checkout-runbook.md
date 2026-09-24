# Runbook: checkout failures

Readable by engineering. This runbook covers the checkout service only. It assumes the reader can
deploy and can page other teams.

## Symptoms

Checkout failures present as a rise in 502s from the payment gateway, a fall in completed orders, or
both. The two do not always move together: a gateway timeout that retries successfully shows as
latency rather than as an error, and the completed-order graph is the one that matters.

## First response

Check the gateway status page before anything else. A vendor-side incident changes the response
entirely, because there is nothing to roll back and the work becomes customer communication.

If the gateway is healthy, compare the current deploy against the last known good one. Roll back
first and diagnose afterwards — a rollback is cheap and a diagnosis under load is not.

## Rollback

Rollback is a single command and takes under two minutes. It does not roll back database migrations,
which is why migrations that are not backward compatible are held behind a flag for one release.

## After

An incident lasting more than ten minutes gets a postmortem. The postmortem names the contributing
factors and the detection gap, and it does not name a person as a cause.
