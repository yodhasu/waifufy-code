# Mod Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Waifufy Code loads mods (panels, backends, agent tools, skills, settings) at runtime from its own mods folder, with the ticket board as the first mod.

**Architecture:** The link discovers mods (`mod.json`), runs each backend as a Node child process under `--permission` speaking newline-delimited JSON-RPC, serves panel files over its `127.0.0.1` HTTP server, and relays panel ↔ backend calls over the existing WebSocket. The app mounts each panel as a sandboxed iframe with a `postMessage` bridge. A Claude Code adapter turns enabled mods' tools into one SDK MCP server and their skills into a generated local plugin.

**Tech Stack:** TypeScript run directly by Node 24 (link), vanilla TS + Vite (app), Tauri 2 (shell), `@anthropic-ai/claude-agent-sdk` 0.3.309, `node:sqlite` (tickets store). Tests: plain `node tests/unit/*.test.mjs` scripts and `tests/e2e/run.mjs` with `WC_E2E_TARGET=browser`.

**Spec:** `docs/superpowers/specs/2026-11-06-mod-support-design.md`

## Global Constraints

- `apiVersion` supported: `1`. Mod `id`: `^[a-z0-9-]+$`.
- Mods folder: `<DATA_DIR>/mods/<id>/`; mod data: `<DATA_DIR>/mod-data/<id>/`; adapter output: `<DATA_DIR>/adapters/claude/waifufy-mods/`. `DATA_DIR` is `link/src/settings.ts:10`.
- Discovery order, first wins on duplicate id: `WC_MODS_DIR`, `<DATA_DIR>/mods`, repo `plugins/*/`.
- Backend: sidecar Node (`process.execPath`), flags `--permission`, `--allow-fs-read=<mod dir>,<declared>`, `--allow-fs-write=<mod data>,<declared>`; env `WC_MOD_ID`, `WC_MOD_DATA`, built from `childEnv()` (no link credentials).
- Timeouts: tool call 10 s, panel call 5 s, panel `ready` 10 s. Restarts: at most 3 per 60 s, then status `crashed`.
- Statuses: `running`, `off`, `crashed`, `invalid`, `incompatible`.
- Panel iframe: `sandbox="allow-scripts"` (never `allow-same-origin`). Mod page CSP: `default-src 'self'; connect-src 'none'`. App Tauri CSP adds `frame-src http://127.0.0.1:*`.
- App events v1: `turn.end`, `emotion`, `affection`, `message` (permissions `events.turn|emotion|affection|message`). Capabilities v1: `chat.send`, `notify`, `theme.set` (permissions `chat.send`, `notify`, `theme`).
- Agent tool names visible to the model: `mcp__waifufy-mods__<tool>`.
- Setting field types: `string`, `number`, `boolean`, `select`, `secret`; `secret` never written to a file.
- Code style: match the surrounding files (header comment explaining the file's role, JSDoc one-liners, no new frameworks).

## Review Focus

1. Install path with spaces (`C:\Users\…\AppData\Roaming\waifufy-code\mods\…`, and the installed app under `Program Files\Waifufy Code`) — permission flags and spawn must work; test in Task 3.
2. Link exits or restarts — no orphaned mod processes, panels reconnect and re-request state; test in Task 3 (kill on `stop()`) and Task 6 (reconnect).
3. A backend that prints a non-JSON or very long stdout line — logged and ignored, the mod keeps running; test in Task 3.
4. Toggling a mod off and on quickly — exactly one backend process and one panel; test in Task 5.
5. Several clients connected (desktop + phone remote) — mod pushes and app events reach every client; test in Task 5.

## Prerequisite

The existing ticket work (`link/src/tickets.ts`, `app/src/plugins/`, `app/src/chat/tickets.ts`, `plugins/waifufy-tickets/`, `tests/unit/tickets.test.mjs`, e2e 31/32) is uncommitted. Before Task 1, Yodha decides where it is committed; this plan assumes it is on `feat/mod-support`.

---

### Task 1: Manifest parsing

**Files:**
- Create: `link/src/mods/manifest.ts`
- Test: `tests/unit/mods-manifest.test.mjs`

**Interfaces:**
- Produces:
  - `type SettingField = { key: string; type: 'string'|'number'|'boolean'|'select'|'secret'; label: string; default?: unknown; options?: string[] }`
  - `type ToolDef = { name: string; description: string; input: Record<string, unknown> }`
  - `type ModManifest = { id; name; version; apiVersion: 1; description: string; defaultEnabled: boolean; panel?: { entry: string; slot: 'chat.left'|'chat.right' }; settingsPage?: string; backend?: { entry: string }; tools: ToolDef[]; skills: string[]; settings: SettingField[]; permissions: string[] }`
  - `parseManifest(raw: unknown, dir: string): { ok: true; manifest: ModManifest } | { ok: false; status: 'invalid'|'incompatible'; reason: string }`
  - `SUPPORTED_API_VERSIONS = [1]`

- [ ] **Step 1: Write failing tests**: `valid manifest parses with defaults (tools [], skills [], settings [], permissions [])`; `unknown fields are ignored`; `id "Bad_Id" → invalid`; `apiVersion 2 → incompatible`; `panel.entry "../x.html" → invalid "path escapes the mod folder"`; `skills ["a"] without skills/a/SKILL.md → invalid`; `duplicate tool names in one mod → invalid`; `select without options → invalid`.
- [ ] **Step 2: Run** `node tests/unit/mods-manifest.test.mjs` — expect FAIL (module missing).
- [ ] **Step 3: Implement `parseManifest`.** Paths checked with `resolve(dir, p)` staying under `resolve(dir)`; files must exist.
- [ ] **Step 4: Run** — expect all PASS; `cd link && npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(mods): manifest parsing (WC-20)`.

### Task 2: Discovery

**Files:**
- Create: `link/src/mods/discover.ts`
- Test: `tests/unit/mods-discover.test.mjs`

**Interfaces:**
- Consumes: `parseManifest` (Task 1)
- Produces:
  - `type DiscoveredMod = { id: string; dir: string; source: 'env'|'installed'|'repo'; manifest?: ModManifest; status: 'ok'|'invalid'|'incompatible'; reason?: string }`
  - `discoverMods(roots?: { env?: string; installed?: string; repo?: string }): DiscoveredMod[]` — defaults from `WC_MODS_DIR`, `join(DATA_DIR,'mods')`, `join(REPO_ROOT,'plugins')`; sorted by `id`.
  - `modsDir(): string`, `modDataDir(id: string): string` (creates it)

- [ ] **Step 1: Failing tests**: `env root wins over installed and repo for the same id`; `folder without mod.json is skipped`; `invalid manifest is listed with status invalid and reason`; `missing roots are fine (empty list)`; `folder name differing from manifest id → invalid "folder name must match id"`.
- [ ] **Step 2: Run** `node tests/unit/mods-discover.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; tsc clean.
- [ ] **Step 5: Commit** `feat(mods): discovery (WC-20)`.

### Task 3: Backend process host

**Files:**
- Create: `link/src/mods/rpc.ts`, `link/src/mods/host.ts`
- Create fixtures: `tests/unit/fixtures/mods/echo/`, `crash/`, `hang/`, `noisy/`, `sqlite/` (each `mod.json` + `backend.mjs`), one fixture folder path containing a space (`tests/unit/fixtures/mods space/echo2/`)
- Test: `tests/unit/mods-host.test.mjs`

**Interfaces:**
- Consumes: `DiscoveredMod`, `modDataDir` (Task 2); `childEnv()` from `link/src/session.ts` (export it if not exported)
- Produces:
  - `class RpcPeer` (rpc.ts): `constructor(input: Readable, output: Writable, onRequest: (method: string, params: unknown) => Promise<unknown>, onLog: (line: string) => void)`; `request(method: string, params: unknown, timeoutMs: number): Promise<unknown>`; `notify(method: string, params: unknown): void`; `close(): void`. Non-JSON lines go to `onLog`; lines over 1 MB are dropped and logged.
  - `nodeArgs(mod: DiscoveredMod): string[]` — permission flags per Global Constraints; expands `%APPDATA%`/`%LOCALAPPDATA%`/`~` in `fs.read:`/`fs.write:` permissions.
  - `class ModHost extends EventEmitter`: `start(mod: DiscoveredMod, settings: Record<string, unknown>): Promise<void>`; `stop(id: string): Promise<void>`; `stopAll(): Promise<void>`; `status(id: string): 'running'|'off'|'crashed'`; `toolCall(id: string, name: string, input: unknown): Promise<unknown>` (10 s); `panelCall(id: string, method: string, params: unknown): Promise<unknown>` (5 s); `event(id: string, type: string, payload: unknown): void`; `settingsChanged(id: string, settings: Record<string, unknown>): void`. Emits `'emit'(id, {type, payload})`, `'app'(id, {capability, params}, reply)`, `'status'(id, status)`.
  - `stderr` appended to `<modDataDir(id)>/mod.log`.

- [ ] **Step 1: Failing tests**: `echo: init then panel.call returns params`; `toolCall routes to tool.call`; `hang: panelCall rejects after 5 s with "timed out"` (inject a shorter timeout via `new ModHost({ panelTimeoutMs: 200 })`); `crash: restarts up to 3 times in 60 s then status crashed`; `noisy: non-JSON stdout is logged, next request still answers`; `stopAll leaves no child processes (pid no longer alive)`; `path with a space spawns and answers`; `sqlite: node:sqlite opens a db in an fs.write path under --permission` (record the result in the spec's "To verify" line); `fs read outside allowed paths fails inside the child (ERR_ACCESS_DENIED)`.
- [ ] **Step 2: Run** `node tests/unit/mods-host.test.mjs` — FAIL.
- [ ] **Step 3: Implement `RpcPeer`, `nodeArgs`, `ModHost`.** Restart window is a sliding 60 s list of crash times; `stop` sends `shutdown`, waits 1 s, then kills.
- [ ] **Step 4: Run** — PASS; tsc clean.
- [ ] **Step 5: Commit** `feat(mods): backend host with permissions, restarts, timeouts (WC-20)`.

### Task 4: Serving panel files and the bridge SDK

**Files:**
- Create: `link/src/mods/http.ts`, `link/src/mods/sdk/waifufy.js`
- Modify: `link/src/server.ts` (the `route` function behind `createServer` at ~line 162: delegate `/mods/` paths)
- Test: `tests/unit/mods-http.test.mjs`

**Interfaces:**
- Consumes: `DiscoveredMod` (Task 2)
- Produces:
  - `panelToken(id: string): string` (random per link run, stable per id) and `checkPanelToken(id: string, token: string): boolean`
  - `serveMod(req: IncomingMessage, res: ServerResponse, mods: () => DiscoveredMod[]): boolean` — handles `/mods/_sdk/waifufy.js` and `/mods/<id>/ui/...?pt=`; returns false for other paths. Sets `Content-Security-Policy: default-src 'self'; connect-src 'none'` on HTML, correct content types for html/js/css/png/svg/json.
  - Bridge SDK globals (`window.waifufy`): `call(method, params): Promise<unknown>`, `on(type, fn): () => void`, `app(capability, params): Promise<unknown>`, `resize(height: number): void`, `ready(): void`, `theme: Record<string,string>`. Wire format to the parent: `{ wc: 1, kind: 'call'|'app'|'resize'|'ready', seq?, method?, capability?, params? }`; from the parent: `{ wc: 1, kind: 'reply'|'event'|'theme', seq?, ok?, value?, error?, type?, payload?, vars? }`.

- [ ] **Step 1: Failing tests**: `serves ui/index.html with the CSP header`; `/mods/tickets/ui/../mod.json → 404`; `%2e%2e encoded escape → 404`; `wrong or missing pt → 403`; `pt of mod A does not open mod B → 403`; `disabled or unknown id → 404`; `/mods/_sdk/waifufy.js served without a token`.
- [ ] **Step 2: Run** `node tests/unit/mods-http.test.mjs` — FAIL.
- [ ] **Step 3: Implement** and add the delegation in `server.ts` before existing routes.
- [ ] **Step 4: Run** — PASS; tsc clean.
- [ ] **Step 5: Commit** `feat(mods): serve panels and bridge SDK (WC-20)`.

### Task 5: Protocol and link wiring

**Files:**
- Create: `link/src/mods/index.ts` (the `Mods` service tying discovery, host, settings, events)
- Modify: `link/src/protocol.ts` (new client/server messages), `link/src/server.ts` (handlers, startup, shutdown, event fan-out), `link/src/settings.ts` (mod enable flags reuse `plugins.<id>`)
- Test: `tests/unit/mods-service.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–4
- Produces:
  - `type ModInfo = { id; name; version; description; status: 'running'|'off'|'crashed'|'invalid'|'incompatible'; reason?: string; enabled: boolean; panel?: { slot: string; url: string }; settingsPageUrl?: string; settings: SettingField[]; values: Record<string, unknown>; permissions: string[]; source: 'env'|'installed'|'repo' }` (in protocol.ts; `url` already carries `?pt=`)
  - Client → link: `{ t: 'mods' }`, `{ t: 'mod-call'; id; seq: number; method; params? }`, `{ t: 'mod-app'; id; seq; capability; params? }`, `{ t: 'mod-enable'; id; enabled: boolean }`, `{ t: 'mod-settings'; id; values: Record<string, unknown> }`, `{ t: 'mod-install'; path: string; replace?: boolean }`, `{ t: 'mod-remove'; id; deleteData?: boolean }`
  - Link → client: `{ t: 'mods'; mods: ModInfo[] }` (sent on request and on every change), `{ t: 'mod-reply'; id; seq; ok: boolean; value?; error? }`, `{ t: 'mod-event'; id; type; payload }`
  - `class Mods`: `init(): Promise<void>`, `list(): ModInfo[]`, `enable(id, on): Promise<void>`, `appEvent(type: 'turn.end'|'emotion'|'affection'|'message', payload): void` (only to mods whose permissions name it), `toolCall(id, name, input)`, `enabledTools(): { id: string; tool: ToolDef }[]`, `enabledSkills(): { id: string; name: string; dir: string }[]`, `on('changed', fn)`.
  - Capability `chat.send` is executed by server.ts through the existing send path; `notify` becomes a toast message the app already draws (reuse its toast message type); `theme.set` broadcasts `{ t: 'mod-event', id: '_app', type: 'theme.set', payload }`.

- [ ] **Step 1: Failing tests** (service with fixture mods and a fake broadcaster): `enable starts one backend; enable twice quickly still one pid`; `disable stops it and list shows off`; `appEvent emotion reaches only mods with events.emotion`; `mod-app capability without its permission → error "permission denied: chat.send"`; `panel emit is broadcast to every connected client` (two fake clients); `settings values persist to mod-data/<id>/settings.json except secret fields`.
- [ ] **Step 2: Run** `node tests/unit/mods-service.test.mjs` — FAIL.
- [ ] **Step 3: Implement**; in server.ts call `mods.init()` at startup, `mods.stopAll()` on exit, and feed `appEvent` from the session's turn-end, emotion tag, affection change and message points (the same places that already broadcast those to the app).
- [ ] **Step 4: Run** — PASS; tsc clean; existing unit tests still pass (`for f in tests/unit/*.test.mjs; do node $f || exit 1; done`).
- [ ] **Step 5: Commit** `feat(mods): link service, protocol and events (WC-20)`.

### Task 6: App panel slot

**Files:**
- Create: `app/src/mods/slot.ts`, `app/src/mods/bridge.ts`, `app/src/mods/mods.css`
- Modify: `app/src/chat/index.ts` (~line 1561: mount mod panels into `chat.left` / `chat.right` hosts instead of `UI_PLUGINS`), `app/src-tauri/tauri.conf.json` (`frame-src http://127.0.0.1:*`)
- Test: e2e `tests/e2e/scenarios/33-mods-panel.mjs` (fixture mod with a panel)

**Interfaces:**
- Consumes: `ModInfo`, `mod-*` messages (Task 5); wire format (Task 4)
- Produces:
  - `mountModPanel(host: HTMLElement, mod: ModInfo, link: Link): () => void` — iframe per Global Constraints, `title` = mod name, bridge on `message` events whose `source` is that iframe's `contentWindow`; sends theme vars (every `--*` custom property on `:root`) on `ready` and on theme change; 10 s `ready` timeout or `crashed` status draws an error card with Retry and Disable (`data-test="mod-error"`).
  - Reconnect: on link reconnect, `mods` is re-requested and every panel re-sent `theme` and a `mod-event` `{ type: 'reconnected' }`.

- [ ] **Step 1: Failing e2e**: `fixture panel appears in chat.left inside a sandboxed iframe (sandbox attr equals "allow-scripts")`; `panel call round-trips to its backend`; `backend push reaches the panel`; `theme vars arrive in the panel`; `crash fixture shows mod-error; Disable removes the panel`; `panel cannot read parent document (access throws)`.
- [ ] **Step 2: Run** `WC_E2E_TARGET=browser node tests/e2e/run.mjs 33-mods` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `cd app && npx tsc --noEmit` clean; `WC_E2E_TARGET=browser node tests/e2e/run.mjs` whole suite still green.
- [ ] **Step 5: Commit** `feat(mods): sandboxed panel slots in the app (WC-20)`.

### Task 7: Claude Code adapter (tools + skills)

**Files:**
- Create: `link/src/mods/claude-adapter.ts`
- Modify: `link/src/session.ts` (options at ~lines 545–584: `mcpServers`, `allowedTools`, `plugins`; live update on `mods` `changed`)
- Test: `tests/unit/mods-adapter.test.mjs`

**Interfaces:**
- Consumes: `Mods.enabledTools()`, `Mods.enabledSkills()`, `Mods.toolCall()` (Task 5)
- Produces:
  - `MODS_SERVER = 'waifufy-mods'`
  - `modsMcpServer(mods: Mods)` — `createSdkMcpServer({ name: MODS_SERVER, tools })`, one `tool()` per enabled tool, input schema passed as JSON Schema; a clashing name keeps the first mod's tool and logs the clash.
  - `modToolNames(mods: Mods): string[]` → `mcp__waifufy-mods__<tool>`
  - `writeSkillsPlugin(mods: Mods, outDir = join(DATA_DIR,'adapters','claude','waifufy-mods')): string` — writes `.claude-plugin/plugin.json` (`{ "name": "waifufy-mods", "version": "1.0.0" }`) and `skills/<modId>-<name>/SKILL.md` (copied), removing stale skill folders; returns `outDir`.
  - Session passes `plugins: [{ type: 'local', path: writeSkillsPlugin(...) }]`; on `changed` it calls `query.setMcpServers({...current, [MODS_SERVER]: modsMcpServer(mods)})`.

- [ ] **Step 1: Failing tests**: `two mods with tools → one server listing both`; `name clash keeps first, logs second`; `skills folder lists only enabled mods and removes a disabled mod's folder`; `generated plugin.json is valid JSON with name waifufy-mods`.
- [ ] **Step 2: Run** `node tests/unit/mods-adapter.test.mjs` — FAIL.
- [ ] **Step 3: Implement** and wire into session.ts.
- [ ] **Step 4: Run** — PASS; tsc clean; mock-session e2e: add to `33-mods-panel.mjs` a test `a mock agent call to the fixture tool reaches its backend` (extend `link/src/mock.ts` with a scripted tool call if it has no hook for arbitrary MCP tools).
- [ ] **Step 5: Commit** `feat(mods): Claude Code adapter for mod tools and skills (WC-20)`.

### Task 8: Mods tab and settings

**Files:**
- Create: `app/src/mods/settings-tab.ts`; Tauri commands `secret_get`, `secret_set`, `secret_delete` in `app/src-tauri/src/secrets.rs` (register them where the app's other commands are registered; add the `keyring` crate, the only new dependency in this plan)
- Modify: `app/src/screens/settings.ts` (replace the Plugins tab at line 37 and its painter at ~912/1756 with the Mods tab), `link/src/mods/index.ts` (install/remove), `tests/e2e/scenarios/31-tickets.mjs` selector `set-plugins.<id>` → `set-mods.<id>`
- Test: `tests/unit/mods-install.test.mjs`, e2e `tests/e2e/scenarios/34-mods-settings.mjs`

**Interfaces:**
- Consumes: `ModInfo`, `mod-enable`, `mod-settings`, `mod-install`, `mod-remove` (Task 5); `mountModPanel` (Task 6, for `settingsPageUrl` in the `settings` slot)
- Produces:
  - `Mods.install(path: string, replace?: boolean): Promise<{ ok: true; id: string } | { ok: false; reason: string; needsReplace?: boolean }>` — validates with `parseManifest`, copies with `cpSync` into `<DATA_DIR>/mods/<id>/`; an existing id without `replace` → `needsReplace: true`.
  - `Mods.remove(id: string, deleteData = false): Promise<void>` — only `source: 'installed'` mods can be removed.
  - Secrets: the app stores `secret` fields with `secret_set("waifufy-mod:<id>", key, value)`; the link receives secret values in `mod-settings` only to forward them to the backend (`init`/`settings.changed`), never persists them.
  - Mods tab rows: `data-test="mod-row"` `data-id`, toggle `data-test="set-mods.<id>"`, status pill, permissions list (shown before first enable), declared settings controls, optional settings page slot, Install from folder (Tauri folder dialog), Remove (with "also delete its data" checkbox).

- [ ] **Step 1: Failing unit tests**: `install valid folder copies it and lists it`; `install invalid folder → ok false with the parser's reason`; `install existing id → needsReplace, then replace: true succeeds`; `remove keeps mod-data unless deleteData`; `repo/env mods cannot be removed`.
- [ ] **Step 2: Failing e2e**: `Mods tab lists fixture mods with status`; `first enable shows the permission list`; `changing a number setting reaches the backend (panel shows new value)`; `secret field value never appears in mod-data/<id>/settings.json`; `custom settings page renders in the settings slot`. (Browser target has no Tauri: the secret test uses the app's fallback in-memory store when `__TAURI__` is absent and asserts the file content.)
- [ ] **Step 3: Run** `node tests/unit/mods-install.test.mjs` and `WC_E2E_TARGET=browser node tests/e2e/run.mjs 34-mods` — FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** both — PASS; app and link tsc clean; `cargo check` in `app/src-tauri` clean.
- [ ] **Step 6: Commit** `feat(mods): Mods tab, install/remove, declared and secret settings (WC-20)`.

### Task 9: Tickets as a mod

**Files:**
- Create: `plugins/waifufy-tickets/mod.json`, `plugins/waifufy-tickets/backend.mjs`, `plugins/waifufy-tickets/ui/index.html`, `ui/board.js`, `ui/board.css`, `plugins/waifufy-tickets/src/tools.mjs`, `plugins/waifufy-tickets/skills/ticket-triage/SKILL.md` (from `commands/triage.md`)
- Modify: `plugins/waifufy-tickets/bin/tickets-mcp.mjs` (import tool definitions from `src/tools.mjs` so both stay identical)
- Test: port `tests/e2e/scenarios/31-tickets.mjs` and `32-tickets-unavailable.mjs` to the mod panel; `plugins/waifufy-tickets/test/` existing tests still pass

**Interfaces:**
- Consumes: bridge SDK (Task 4), host protocol (Task 3), Mods tab (Task 8)
- Produces:
  - `src/tools.mjs`: `export const TOOLS` (the 7 definitions now in `bin/tickets-mcp.mjs`: `ticket_board`, `ticket_create`, `ticket_list`, `ticket_get`, `ticket_move`, `ticket_update`, `ticket_comment`) and `export function runTool(store, name, input)`.
  - `mod.json`: id `tickets`, version `0.2.0`, panel `ui/index.html` in `chat.left`, backend `backend.mjs`, `tools` = `TOOLS` (generated into mod.json by `node plugins/waifufy-tickets/bin/sync-mod.mjs`, checked by a test so they never drift), skills `["ticket-triage"]`, settings `project` (string, default `""`) and `doneLimit` (number, default `10`), permissions `["events.turn", "agent.tools", "fs.read:%APPDATA%/waifufy-tickets", "fs.write:%APPDATA%/waifufy-tickets"]` (adjust per Task 3's sqlite finding).
  - Backend panel methods: `board({ project?, doneLimit? }) → BoardSnapshot` (same shape as `link/src/protocol.ts` today); pushes `{ type: 'changed' }` after any write tool and on `turn.end`.
  - UI: same markup, `data-test` names and behaviour as today's card (`tickets-card`, `tickets-column`, refresh button, collapsed Done, unavailable/empty states).

- [ ] **Step 1: Port e2e 31/32** to drive the iframe (use the frame locator for `data-test` selectors) and add `a ticket_create through the mods tool server refreshes the panel`; `mod.json tools equal src/tools.mjs TOOLS` as a unit test in `plugins/waifufy-tickets/test/`.
- [ ] **Step 2: Run** `WC_E2E_TARGET=browser node tests/e2e/run.mjs tickets` and `node --test plugins/waifufy-tickets/test/` — FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** both — PASS.
- [ ] **Step 5: Commit** `feat(tickets): ship the ticket board as a Waifufy mod (WC-20)`.

### Task 10: Remove the old seam

**Files:**
- Delete: `link/src/tickets.ts`, `app/src/chat/tickets.ts`, `app/src/chat/tickets.css`, `app/src/plugins/`, `tests/unit/tickets.test.mjs`
- Modify: `link/src/protocol.ts` (drop `tickets` messages and `BoardSnapshot` export if unused), `link/src/server.ts` (drop `case 'tickets'`), `app/src/chat/index.ts`, `scripts/stage-sidecar.mjs` (no change expected; confirm `plugins/` is not needed), docs `docs/V0.8.4.md` or the next version note (mods section, install steps)

- [ ] **Step 1: Delete and fix references**; `grep -rn "ticketBoard\|UI_PLUGINS\|ticketsPlugin" link/src app/src` returns nothing.
- [ ] **Step 2: Run** all unit tests, both tsc checks, and `WC_E2E_TARGET=browser node tests/e2e/run.mjs` — all PASS.
- [ ] **Step 3: Manual check (Yodha):** build the installer (`npm run build:installer`), install, copy `plugins/waifufy-tickets` via Mods → Install from folder, enable it, see the board; then `claude plugin uninstall waifufy-tickets@waifufy` and confirm Rem still has `mcp__waifufy-mods__ticket_board` in a new session.
- [ ] **Step 4: Commit** `refactor(mods): remove the built-in ticket seam (WC-20)`.
