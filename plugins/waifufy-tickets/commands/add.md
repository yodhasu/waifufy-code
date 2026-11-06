---
description: Add a ticket to the board from a short description
argument-hint: <title or description>
allowed-tools: mcp__tickets__ticket_list, mcp__tickets__ticket_create
---

Turn `$ARGUMENTS` into one ticket.

1. `ticket_list` with a `query` made of the important words, to catch an existing card for the same problem. If one exists, say which card it is and stop — do not duplicate it.
2. `ticket_create` with:
   - `title`: imperative, one line, what has to become true ("Fix X", "Add Y").
   - `body`: what is wrong, what done looks like. If the user gave no specifics, write only what they said — do not invent acceptance criteria.
   - `source`: `$ARGUMENTS` verbatim.
   - `dedupe_key`: `<project>:<three-or-four-word-slug>` if you can name the project, otherwise omit it.
   - `project`: only if the user named one or it is obvious from the text.
   - `priority`: 2 only if the user said urgent/broken-now, otherwise leave unset.

Default status is `inbox`; leave it there unless the user asked for a specific column. Report the new id and title in one line.
