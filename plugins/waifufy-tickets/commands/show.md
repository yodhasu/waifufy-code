---
description: Show one ticket in full, with comments and recent history
argument-hint: <id>
allowed-tools: mcp__tickets__ticket_get
---

Call `ticket_get` for `$1` with `events: 10`.

Print the ticket verbatim, then add at most three lines of your own reading: what it is actually asking for, whether the raw input it came from is enough to act on (or what is missing), and — if it is blocked — what would unblock it. Do not start the work.
