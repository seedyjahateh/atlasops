# Engineering handbook

This document is a parser fixture. Its exact bytes are the input under test, which is
why it is listed in .prettierignore — reformatting it would rewrite the assertions.

## On-call

The rotation is weekly and hands over at 10:00 on Monday. The outgoing engineer writes
a handover note before the handover call, not after it.

### Escalation

Escalate when a customer-visible symptom has lasted ten minutes and you do not yet have
a hypothesis you can test.

- Page the secondary.
- Post in the incident channel with what you know and what you have ruled out.
- Do not wait for the primary to give up before paging.

### Handover

The handover note names the open incidents, the changes still in flight, and anything
that will page overnight.

## Retention

Build logs are kept for ninety days. Traces are kept for thirty.

| Artefact   | Retention | Owner    |
| ---------- | --------- | -------- |
| Build logs | 90 days   | Platform |
| Traces     | 30 days   | Platform |
| Audit      | 7 years   | Security |

Deleting early is a change with a reviewer, not an operational convenience.

## Draining the ingest worker

Drain before restarting. A restart without a drain loses whatever the worker had
accepted and not yet written.

```bash
atlasops ingest drain --wait
atlasops ingest status
systemctl restart atlasops-ingest
```

The status command exits non-zero while the queue is non-empty, so the drain can be
waited on in a script.
