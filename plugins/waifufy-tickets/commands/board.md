---
description: Show the ticket board (all columns) and read it back to the user
argument-hint: [project]
allowed-tools: mcp__tickets__ticket_board, mcp__tickets__ticket_get
---

Call `ticket_board` with `project: $1` (omit the argument entirely if `$1` is empty).

Then report, in this order and briefly:

1. The board itself, verbatim (it is already column layout — do not re-draw it as a list or add ASCII art).
2. **Blocked** — every blocked card with the thing it is waiting on. If nothing is blocked, say so in one line.
3. **Doing** — what is actually in progress right now.
4. **Next up** — at most 3 Todo cards, priority first then oldest, with a one-line reason each.

Do not start work on anything. This command only reports. If the board is empty, say it is empty and suggest `/tickets:triage` with the raw input to fill it.
