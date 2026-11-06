---
description: Move a ticket between columns
argument-hint: <id> <inbox|todo|doing|blocked|done> [reason]
allowed-tools: mcp__tickets__ticket_get, mcp__tickets__ticket_move
---

Move ticket `$1` to `$2`, with `$3` onward as the reason when one is given.

- `blocked` **requires** a reason: say what it is waiting on and who or what unblocks it. If `$3` is empty, ask for the reason instead of guessing, and do not move the card.
- `doing` means work is starting now; `done` means it is finished — not that it was committed, attempted, or partly done.
- For anything else, pass `$3` through as a `comment` if the user gave one.

If the move fails because the id does not exist, `ticket_list` once to find the intended card and confirm before retrying. Report the transition in one line (`WC-4: doing -> done`).
