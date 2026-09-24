# Postmortem: credential exposure

Date: 2026-07-03
Severity: 1

## What happened

A payment gateway credential was written to a debug log during a checkout incident and retained for
nine days before it was found and rotated.

## Contributing factors

A temporary debug flag enabled during the incident logged full request headers, and was not removed
when the incident closed.

## Follow-ups

Debug logging never includes authorisation headers. Temporary flags expire automatically.
