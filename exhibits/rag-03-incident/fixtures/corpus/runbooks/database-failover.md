# Runbook: database failover

Service: orders-db
Owner: platform on-call

## Symptoms

Write latency on the orders database above two seconds, or replication lag above thirty seconds on
the primary's health panel.

## Before failing over

Confirm the replica is caught up. Failing over to a replica that is behind loses the writes it has
not yet received, and those cannot be recovered afterwards.

## Failover

Failover promotes the replica and repoints the connection string. It is performed by a person, with a
second person watching the replication panel, and takes about four minutes.
