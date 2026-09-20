# Operations handbook

This handbook is the standing answer to questions that come up during an incident. It is
deliberately boring, and it is the document a tired person reads at three in the morning.

## On-call

### Rotation

The rotation is weekly and hands over at 10:00 on Monday. The outgoing engineer writes the
handover note before the handover call rather than after it, so the call has something to
argue with.

### Paging

A page means a human is expected to be looking within five minutes. Anything that does not
meet that bar is a ticket, and filing it as a page is how a rotation stops being able to
tell the two apart.

### Escalation

Escalate when a customer-visible symptom has lasted ten minutes and you do not yet have a
hypothesis you can test. Escalating early is cheap; escalating late is the thing every
post-incident review ends up discussing.

- Page the secondary.
- Post in the incident channel with what you know and what you have ruled out.
- Do not wait for the primary to give up before paging.

### Handover

The handover note names the open incidents, the changes still in flight, and anything that
is expected to page overnight. A note that says "quiet week" and nothing else is not a
handover.

## Change management

### Deploys

Deploys go out behind a flag that defaults to off, and the flag is turned on in a separate,
reversible step. A deploy and a release are different events, and conflating them removes
the only cheap rollback anybody has.

### Rollback

Rollback is the first response to a customer-visible regression, not the last. Diagnosis is
easier with the symptom stopped, and a rollback that turns out to have been unnecessary has
cost an afternoon rather than a day.

### Freezes

A freeze is a decision somebody makes and announces, with an end date. A freeze that nobody
declared and nobody can lift is just a team that has stopped shipping and has not said so
out loud.

## Data handling

### Retention

Build logs are kept for ninety days and traces for thirty. Deleting early is a change with a
reviewer, not an operational convenience, because somebody is usually mid-investigation when
it seems like a good idea.

| Artefact   | Retention | Owner    |
| ---------- | --------- | -------- |
| Build logs | 90 days   | Platform |
| Traces     | 30 days   | Platform |
| Audit      | 7 years   | Security |

### Exports

An export of customer data is an access event and is logged as one. The log entry names the
principal, the scope and the reason, and an export with no stated reason is refused rather
than queued for somebody to explain later.

### Backups

Backups are verified by restoring them, on a schedule, into an environment nobody is using.
A backup that has never been restored is a belief about a backup, and the difference shows
up exactly once.

## Running the ingest worker

### Draining

Drain before restarting. A restart without a drain loses whatever the worker had accepted
and not yet written, and the loss is silent because the accepting side already returned
success to its caller.

```bash
atlasops ingest drain --wait
atlasops ingest status
systemctl restart atlasops-ingest
```

### Status

The status command exits non-zero while the queue is non-empty, so a drain can be waited on
from a script without polling a dashboard. It reports the queue depth and the age of the
oldest item, and the age is the number that matters.

### Backfills

A backfill runs against the same pipeline as a live crawl and is not a separate code path.
A backfill tool that takes a shortcut is a second implementation of ingestion, and the two
diverge on the week nobody has time to notice.
