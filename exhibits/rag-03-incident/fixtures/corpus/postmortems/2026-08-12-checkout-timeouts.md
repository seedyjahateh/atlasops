# Postmortem: checkout timeouts

Date: 2026-08-12
Severity: 2
Duration: 38 minutes

## What happened

Checkout requests timed out for thirty-eight minutes after a payments deploy changed the gateway
client's connection pool size from forty to four. Completed orders fell by roughly half.

## Contributing factors

The pool size was read from a configuration default that had changed between library versions. The
deploy's canary stage ran at low traffic, where four connections were enough.

## Detection gap

The latency panel moved eleven minutes before the error alert fired. The alert was on errors only.

## Follow-ups

Alert on checkout latency as well as errors. Pin the gateway client's pool size explicitly.
