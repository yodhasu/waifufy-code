---
description: Triage raw input into tickets (you are the filter — this version has no separate triage model)
argument-hint: [raw text, or a path to a file/export to read]
allowed-tools: mcp__tickets__ticket_list, mcp__tickets__ticket_board, mcp__tickets__ticket_create, mcp__tickets__ticket_get, Read, Glob, Grep
---

You are the triage layer. Do the filtering yourself, in this conversation: there is no cheaper model downstream, and you must not delegate this to a subagent.

**Input**: `$ARGUMENTS`. If it is empty, ask the user to paste the raw input (chat transcript, Slack/WhatsApp export, log, email, bug report) or give a path, then stop. If `$ARGUMENTS` is a path that exists, `Read` it — do not paraphrase from memory.

**Do this, in order:**

1. **Read the raw input properly.** Note how many distinct problems it contains and who reported each one. If it is a transcript, keep the human's own wording.

2. **Resolve the project for each item.** The session workspace is usually the parent folder of several repos; a project is a folder with its own `.git`. `Glob` for `*/` (or `*/.git`) to see what exists, and call `ticket_list` once with no filters to see the project labels already in use. If an item maps to nothing that exists, leave `project` unset rather than inventing a name — the card will sit in the unsorted pile and you will mention it.

3. **Dedupe against the board.** `ticket_list` (no filters, limit 200) and compare on *meaning*, not wording: same root cause or same requested outcome means the same ticket. For each item decide one of:
   - **new** → create it
   - **already tracked** → say which id and why it matches, create nothing
   - **not a ticket** → a question, a status update, an opinion. Say so and create nothing.
   Re-running this command over the same input later must not produce duplicates: that is what `dedupe_key` is for.

4. **Create one ticket per atomic problem.** Split anything that is really two problems, even if it arrived as one sentence. For each:
   - `title`: imperative, one line, names the outcome.
   - `body`: the problem, the evidence from the input (error text, file, screenshot path, environment), and what "done" plausibly looks like. Mark anything you inferred with "assumed:" so the human can correct it. Never invent requirements the input does not support.
   - `source`: the raw input **verbatim** — the whole relevant excerpt, not a summary. This is what a later re-triage and the future fix loop read.
   - `source_ref`: where it came from, e.g. `slack #dev 2026-11-05`, a file path, or `chat`.
   - `dedupe_key`: `<project>:<short-slug>`, lowercase, no spaces. Deterministic — the same problem must produce the same key every run.
   - `project`, `priority` (2 only for broken-now/blocking), `labels` if the input implies them.
   - Status: `inbox` unless the input clearly says it is already agreed work.

5. **Report a short table** with one row per item: `new WC-7 · already tracked WC-3 · not a ticket`, then the id, then the title. Follow with one line listing anything you deliberately did not create and why, and one line naming the tickets you would pick up first.

**Hard rules**
- Do not fix, investigate, or reproduce anything. Triage produces cards, nothing else.
- Do not create a ticket for something you cannot state as an outcome.
- Ambiguity is not a reason to guess: put the card in `inbox` with the ambiguity written in the body, or ask the user if the whole input is ambiguous.
- If the input is one long stream of consciousness, it is still often 3–8 tickets. Find them. One ticket containing "and also" is a failed triage.
