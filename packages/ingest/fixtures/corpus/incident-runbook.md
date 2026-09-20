# Incident runbook

## Declaring

Anybody may declare an incident and nobody needs permission. The cost of a declaration that
turns out to be unnecessary is one message; the cost of hesitating is the part of the
outage nobody was working on.

## Roles

One person runs the incident and does not also debug it. The incident lead holds the
timeline, decides what is tried next, and is the only person who talks to anybody outside
the channel.

## Communicating

Status goes out every twenty minutes whether or not anything changed, because silence is
read as either "fixed" or "abandoned" and it is neither. A status with no new information
still says what is being tried.

## Closing

An incident closes when the symptom is gone, not when the cause is understood. The
understanding is the review's job, and holding the incident open until somebody has it
keeps a room full of people on a call they are no longer useful in.
