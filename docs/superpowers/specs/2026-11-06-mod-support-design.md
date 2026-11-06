# Mod support — design

Date: 2026-11-06 · Ticket: WC-20 · Status: approved in chat, awaiting spec review

## Goal

Let Waifufy Code load optional features ("mods") at runtime, like game mods: install or update a mod without
rebuilding or reinstalling the app. The ticket board becomes the first mod and the proof that the design works.

## Decisions agreed in the design chat

- Audience: trusted mods today (the owner and people he shares the app with), designed so a public marketplace
  can come later without rewriting mods.
- Power: deep hooks (panels, agent tools, skills, app events, theme), exposed through a message API rather than
  raw DOM access.
- Waifufy owns the mod format. Claude Code is one adapter, not the host: no mod depends on `~/.claude` or the
  Claude Code plugin format, so the app can move to another agent harness (e.g. Omnissiah) by writing a new adapter.
- Approach B: each panel is a sandboxed iframe; each backend is its own Node child process.
- In v1: panels, backend, agent tools, skills, declared settings + optional settings page, Mods tab with install
  from folder. Out of v1: zip install, marketplace, network sandboxing, more slots.

## 1. Mod package and discovery

A mod is a folder:

```
<id>/
  mod.json
  ui/index.html (+ js, css)        optional panel
  ui/settings.html                 optional custom settings page
  backend.mjs                      optional backend
  skills/<name>/SKILL.md           optional agent skills
```

`mod.json`:

```json
{
  "id": "tickets",
  "name": "Ticket board",
  "version": "0.2.0",
  "apiVersion": 1,
  "description": "Read-only ticket board beside the chat.",
  "defaultEnabled": false,
  "panel": { "entry": "ui/index.html", "slot": "chat.left" },
  "settingsPage": "ui/settings.html",
  "backend": { "entry": "backend.mjs" },
  "tools": [{ "name": "ticket_board", "description": "…", "input": { "type": "object", "properties": {} } }],
  "skills": ["ticket-triage"],
  "settings": [
    { "key": "project", "type": "string", "label": "Default project", "default": "" },
    { "key": "doneLimit", "type": "number", "label": "Done cards shown", "default": 10 }
  ],
  "permissions": ["events.turn", "fs.read:%APPDATA%/waifufy-tickets", "fs.write:%APPDATA%/waifufy-tickets", "agent.tools"]
}
```

Rules:

- `id`: `[a-z0-9-]+`, unique. `apiVersion` must be one the app supports (v1: `1`); otherwise the mod is listed
  as `incompatible` and not loaded.
- Every path in the manifest is relative to the mod folder and must resolve inside it.
- Unknown fields are ignored (forward compatibility). A manifest that fails validation lists the mod as `invalid`
  with the reason; it never stops the app.

Discovery, first match wins on a duplicate `id`:

1. `WC_MODS_DIR` (dev, tests)
2. `<data dir>/mods/<id>/` — the installed mods (`<data dir>` is the link's existing `DATA_DIR`)
3. the repo's `plugins/*/` when running from source

Enabled state: the existing `plugins.<id>` settings flag (renamed in the UI to "Mods"), defaulting to
`defaultEnabled`. A disabled mod loads nothing: no process, no panel, no tools, no skills.

Slots in v1: `chat.left`, `chat.right`, `settings` (the per-mod settings page). New slots are additive.

## 2. Backend runtime (link: `ModHost`)

- For each enabled mod with a backend, the link starts `<sidecar node.exe> backend.mjs` with cwd = mod folder.
- Environment: `WC_MOD_ID`, `WC_MOD_DATA=<data dir>/mod-data/<id>/`. No app tokens or secrets.
- Node permission model: `--permission`, `--allow-fs-read=<mod folder>,<declared fs.read paths>`,
  `--allow-fs-write=<mod data>,<declared fs.write paths>`; no `--allow-child-process` / `--allow-worker` unless
  declared. `%APPDATA%`-style variables in declared paths are expanded by the link.
- Network is not restricted in v1 (Node cannot enforce it); `net` permissions are recorded only.
- Protocol: JSON-RPC 2.0, newline-delimited JSON over stdin/stdout; stderr goes to `<data dir>/mod-data/<id>/mod.log`.

Link → mod: `init({ apiVersion, settings, grantedPermissions })`, `tool.call({ name, input })`,
`event({ type, payload })`, `panel.call({ method, params })`, `settings.changed({ settings })`, `shutdown`.

Mod → link: `panel.emit({ type, payload })`, `app.call({ capability, params })`, `log({ level, message })`.

App events in v1: `turn.end`, `emotion`, `affection`, `message`. A mod receives only those its permissions name
(`events.turn`, `events.emotion`, `events.affection`, `events.message`).

Capabilities in v1 (each needs its permission): `chat.send` (`chat.send`), `notify` (`notify`), `theme.set`
(`theme`).

Failures: tool calls time out after 10 s, panel calls after 5 s. A crashed backend restarts at most 3 times per
minute, then the mod is marked `crashed`; its panel and the Mods tab show it. The rest of the app keeps running.

To verify in the build: `node:sqlite` under `--permission` with the Tickets database path. If it does not work,
Tickets declares the wider path it needs and the finding is written into this spec.

## 3. Panels (app: `ModSlot`)

- The link serves `/mods/<id>/ui/…` from the mod folder on its existing `127.0.0.1` HTTP server, with a path
  traversal guard and a per-mod panel token (`pt`) that only unlocks that mod's files.
- Mod pages are served with their own CSP: `default-src 'self'; connect-src 'none'` (panels do all I/O through
  the bridge).
- The app mounts `<iframe sandbox="allow-scripts" title="<mod name>" src="http://127.0.0.1:<port>/mods/<id>/ui/index.html?pt=…">`.
  No `allow-same-origin`, so a panel cannot read the app's storage or DOM.
- The app's Tauri CSP gains `frame-src http://127.0.0.1:*` (the one rebuild this feature needs).
- Bridge SDK, served at `/mods/_sdk/waifufy.js`:
  - `waifufy.call(method, params)` → the mod's backend (`panel.call`)
  - `waifufy.on(type, fn)` → backend pushes and permitted app events
  - `waifufy.app(capability, params)` → permission-checked app capabilities
  - `waifufy.resize(height)` → fit the slot
  - `waifufy.ready()` → tells the app the panel loaded
- Transport: `postMessage` between iframe and app with a source check; the app relays to the link over new
  WebSocket messages `{ t: 'mod', id, … }`.
- Theme: the app sends its CSS variables (colours, fonts, light/dark) on load and on change. A mod with the
  `theme` permission may set app variables via `theme.set`.
- Failure: no `ready` within 10 s, or a `crashed` backend, shows an error card with Retry and Disable.

## 4. Agent adapter (Claude Code)

The only Claude-Code-specific code. A future harness gets its own adapter over the same mod data.

- Tools: one in-process MCP server `waifufy-mods` built with the Agent SDK's `createSdkMcpServer` from every
  enabled mod's `tools`. Calls go to `ModHost.toolCall`. The agent sees `mcp__waifufy-mods__<tool>`. Tool names
  must be unique across enabled mods; a clash disables the later mod's tool and logs it. Enabling or disabling a
  mod updates the live session with `setMcpServers()`.
- Skills: the adapter generates `<data dir>/adapters/claude/waifufy-mods/` with a minimal plugin manifest and
  `skills/<modId>-<name>/SKILL.md` copied from every enabled mod, and passes it via the SDK option
  `plugins: [{ type: 'local', path }]`. It is rebuilt on every enable/disable/install; skills take effect from the
  next session.

## 5. Settings

- Mods tab (replaces the Plugins tab): each mod with version, status (`running` / `off` / `crashed` /
  `invalid` / `incompatible`), requested permissions, and an enable toggle. First enable shows the permission
  list (display only in v1; the future marketplace prompt).
- Install from folder: validate `mod.json`, then copy into `<data dir>/mods/<id>/` (replacing an older version
  of the same id after confirmation). Remove deletes that folder; the mod's data folder is kept unless the user
  ticks "also delete its data".
- Declared settings: `settings` fields drawn as native app controls. Types: `string`, `number`, `boolean`,
  `select` (with `options`), `secret`. Values in `<data dir>/mod-data/<id>/settings.json`; `secret` values in the
  OS credential store through Tauri, never in a file. The backend gets values in `init` and on `settings.changed`.
- Custom page: `settingsPage` renders in the `settings` slot under the mod's entry, same sandbox and bridge.

## 6. Tickets migration (the proof)

`plugins/waifufy-tickets/` gains `mod.json`, `ui/` (today's `app/src/chat/tickets.ts` rewritten against the
bridge), `backend.mjs` (wraps `src/store.mjs`, serves the board and the 7 ticket tools), and declared settings
(default project, Done cards shown). When the mod reaches parity with today's card:

- delete `link/src/tickets.ts`, the `tickets` protocol messages, and `app/src/chat/tickets.ts`
- uninstall `waifufy-tickets@waifufy` from Claude Code; the ticket tools now come from the app
- keep the plugin's CLI (`bin/tickets.mjs`)

## 7. Testing

Unit (`tests/unit/`):

- manifest validation (valid, invalid, unknown fields, path escape, apiVersion)
- discovery precedence and duplicate ids
- static file path traversal guard and panel token scope
- `ModHost` with fake mods: echo, crash (restart then `crashed`), hang (timeout), permission-denied capability
- `node:sqlite` under `--permission`
- skills adapter output and tool-name clash handling

E2E (`WC_E2E_TARGET=browser`):

- the tickets mod draws the board in its iframe; refresh works
- an agent ticket tool call (mock session) goes through the mod
- a crashing mod shows the error card; Retry and Disable work
- disabling a mod removes its panel, tools and skills
- declared settings change the board (project filter, Done limit)
- port scenarios 31 and 32

## Out of scope for v1

Zip install, marketplace and signing, network sandboxing, slots beyond `chat.left` / `chat.right` / `settings`,
mod-to-mod communication.
