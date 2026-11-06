# waifufy-tickets (v0)

A local kanban board for agent-driven triage. It is a **Claude Code plugin**, not part of the
Waifufy Code installer: a folder you install, enable, and remove again without touching the app.

v0 is the **board and the filter** — deliberately nothing else:

- **You are the filter.** The main agent reads raw input (a chat paste, a Slack export, a log, a file)
  and turns it into atomic tickets. There is no second, cheaper triage model in this version.
- **It is a plain todo kanban**: `Inbox → Todo → Doing → Blocked → Done`, moved by hand or by the agent.
- **No automation.** No dispatcher, no workers, no verify gate. That is phase 2 (see "Not in v0").

## Install

```
node plugins/waifufy-tickets/install.mjs            # install it, left off
node plugins/waifufy-tickets/install.mjs --enable   # install it and turn it on
```

or, by hand, in Claude Code (`install` turns a plugin on, so the third line is what keeps it off):

```
/plugin marketplace add C:\Users\mybook\Documents\Work\waifufy-code\plugins\waifufy-tickets
/plugin install waifufy-tickets@waifufy
/plugin disable waifufy-tickets@waifufy
```

Nothing is compiled and there are no dependencies to install: the store uses Node's built-in
`node:sqlite` (Node ≥ 22.5; this repo already needs Node 24).

The plugin is **off by default**. `claude plugin install` enables a plugin, and this one adds about
100 always-on tokens to every session (`claude plugin details waifufy-tickets@waifufy` prints the
estimate), so `install.mjs` turns it back off unless you pass `--enable`. Other modes: `--off`,
`--status`, `--json`, `--dry-run`, `--uninstall`.

## Use

| Command | What it does |
| --- | --- |
| `/waifufy-tickets:triage <raw text or a file path>` | The main agent filters the input into tickets and reports what it created, what was already tracked, and what it judged not to be a ticket. |
| `/waifufy-tickets:board [project]` | Prints the board and calls out blocked / doing / next up. |
| `/waifufy-tickets:add <description>` | One ticket from a short description. |
| `/waifufy-tickets:show <id>` | One ticket in full, with comments and history. |
| `/waifufy-tickets:move <id> <status> [reason]` | Moves a card. `blocked` requires a reason. |

The agent also gets seven MCP tools: `ticket_board`, `ticket_create`, `ticket_list`, `ticket_get`,
`ticket_move`, `ticket_update`, `ticket_comment`. They are thin wrappers over the same store the
commands and the CLI use.

### Terminal (no agent needed)

```
node plugins/waifufy-tickets/bin/tickets.mjs board
node plugins/waifufy-tickets/bin/tickets.mjs add "Fix the save race" --project waifufy-code --dedupe wc:save-race
node plugins/waifufy-tickets/bin/tickets.mjs move WC-1 doing
node plugins/waifufy-tickets/bin/tickets.mjs show WC-1 --events 10
node plugins/waifufy-tickets/bin/tickets.mjs board --html board.html   # standalone snapshot you can open
```

`--json` on any of them makes the output machine-readable; `--help` lists everything.

## Where the data lives

SQLite (WAL) at `<config>\waifufy-tickets\kanban.db` — `%APPDATA%` on Windows, `~/.config`
elsewhere. `WC_TICKETS_DB` overrides the path. It is deliberately **not** inside the app's data
directory: the board belongs to the plugin, so uninstalling the app does not take your tickets.

Two surface-specific notes: the database is plaintext (do not paste secrets into a ticket body), and
three surfaces may write it (the CLI, the MCP server, a UI) — that is safe because every write takes a
`BEGIN IMMEDIATE` transaction with a 5 s busy timeout.

## Design notes

- **Raw input is kept verbatim** in `source`, with `source_ref` naming where it came from. A ticket can
  therefore be re-triaged later without asking the human to paste anything again.
- **`dedupe_key`** is a unique partial index, so re-running triage over the same input returns the
  existing ticket (`already tracked as WC-3`) instead of creating a duplicate. Deterministic keys are
  what make the filter idempotent.
- **`ticket_events` is append-only** with a monotonic id: a UI can tail `eventsSince(cursor)` instead of
  polling for diffs, and a deleted ticket still leaves an audit trail.
- **Human ids** are `WC-<n>`, so a ticket number is safe to say out loud in chat.
- **`blocked` requires a reason** — enforced in the store, not just in the prompt, so the board always
  explains what a card is waiting on.
- The state machine lives in `src/store.mjs` and is the only writer; the CLI, the MCP server and the
  (future) app panel all go through it.

## Not in v0

- No create/move from the app panel (read-only), no per-project concurrency, no dispatcher, no
  frozen-oracle verify gate, no notifications. The design for those is the "tier 2" work: see
  `INTEGRATION.md` for the app view and the phase plan for the fix loop.
- No second triage model. The main agent filters; a cheap model is an optimisation to add only after
  ticket quality is proven.

## Tests

```
cd plugins/waifufy-tickets && npm test
```

26 assertions over the store (ids, dedupe, moves, blocked reasons, ordering, events, persistence) plus
end-to-end tests that spawn the real CLI and speak JSON-RPC to the real MCP server over stdio.

## Files

```
.claude-plugin/plugin.json      plugin manifest
.claude-plugin/marketplace.json single-plugin marketplace (install from this folder)
.mcp.json                       registers the stdio MCP server
commands/                       the five slash commands (triage is the filter)
bin/tickets.mjs                 CLI
bin/tickets-mcp.mjs             MCP stdio server (hand-rolled JSON-RPC, no dependencies)
src/store.mjs                   SQLite store, state machine, event log
src/render.mjs                  terminal board / ticket / list / HTML board
test/                           node:test suites
install.mjs                     one-command install / status / uninstall
INTEGRATION.md                  frozen interface for the Waifufy Code panel
```
