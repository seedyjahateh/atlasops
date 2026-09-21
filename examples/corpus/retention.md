# Retention policy

## Periods

Build logs are retained for ninety days, traces for thirty, and audit records for seven years. The
audit period is set by the obligation rather than by the storage cost.

## Deletion

Deletion is a hard operation. A record that has been deleted is absent from the primary store, from
every index built over it, and from every cache keyed on it, before the job that performed the
deletion reports success.
