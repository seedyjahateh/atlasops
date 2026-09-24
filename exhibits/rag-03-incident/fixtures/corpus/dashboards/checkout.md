# Dashboard: checkout

Service: checkout

## Panels

The latency panel shows p50 and p95 for the checkout endpoint. The error panel shows the rate of 5xx
responses. The orders panel shows completed orders per minute against the same hour last week.

## Reading it during an incident

Latency moves first. A p95 above two seconds with errors still flat is the gateway timing out and
retrying, and errors follow within minutes if nothing changes.
