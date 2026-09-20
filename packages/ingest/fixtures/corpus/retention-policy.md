# Retention policy

## Scope

This policy covers operational telemetry and build artefacts. Customer content is governed
separately, under the data processing agreement, and nothing here relaxes that.

## Periods

Build logs are retained for ninety days, traces for thirty, and audit records for seven
years. The audit period is set by the obligation rather than by the storage cost, and it is
not negotiable against a quarterly budget.

## Deletion

Deletion is a hard operation. A record that has been deleted is absent from the primary
store, from every index built over it, and from every cache keyed on it, before the job that
performed the deletion reports success.

## Exceptions

An exception is granted by the data owner, in writing, with an expiry date. An exception
with no expiry is a permanent change to the policy, and it is made as one or not at all.
