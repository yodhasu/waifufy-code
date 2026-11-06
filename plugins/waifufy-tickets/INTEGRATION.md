# waifufy-tickets ↔ waifufy-code integration (v0)

The ticket **engine** lives entirely in this folder (SQLite store, CLI, MCP server) and works
without the app: Claude Code installs it as a plugin, a terminal drives it with `bin/tickets.mjs`.
The app gets only a **view**: a thin, default-off panel that reads the same database.

This file is the frozen interface for that view. Both sides build against it; change it before
changing either side.

## 1. What the panel is

- A **left-side card in the chat screen**, below the composer's mode/model row (the model picker and
  the chat-mode / permission-mode controls). Scrollable, status-grouped lists.
- **Read-only in v0.** No create, move, edit or comment from the panel — the agent and the CLI do
  that. (Moving cards later means new link ops plus optimistic UI; not now.)
- **Default OFF.** Nothing renders, and link never touches the store, unless the user enables it.
- Absent plugin folder ⇒ the panel shows an install hint instead of an empty board.

## 2. Link side (owner: link-bridge)

### 2.1 `link/src/protocol.ts`

Two additions, following the `slack_*` messages: session-independent, so they work with no live
`Live` session (do **not** route these through `ctl`, which needs `live()`).

In `ClientMsg`:

```ts
| { t: 'tickets'; project?: string }
```

In `ServerMsg`:

```ts
| { t: 'tickets'; board: BoardSnapshot }
```

Shared types, exported from `protocol.ts` (the app imports them from here):

```ts
/** One card as the panel draws it. `body` is present so expanding a card needs no round trip. */
export interface TicketCard {
  id: string
  title: string
  status: TicketStatus
  priority: number
  project?: string
  labels: string[]
  body?: string
  blockedReason?: string
  sourceRef?: string
  createdAt: number
  updatedAt: number
}

export type TicketStatus = 'inbox' | 'todo' | 'doing' | 'blocked' | 'done'

export interface TicketColumn { status: TicketStatus; label: string; hint: string; tickets: TicketCard[] }

/** `available: false` means the plugin folder could not be loaded; `reason` says why, verbatim for the UI. */
export interface BoardSnapshot {
  available: boolean
  reason?: string
  dbPath?: string
  generatedAt: number
  total: number
  counts: Record<TicketStatus, number>
  projects: { project: string; count: number }[]
  columns: TicketColumn[]
}
```

### 2.2 `link/src/tickets.ts` (new)

- `ticketBoard(project?: string): Promise<BoardSnapshot>` — never throws for a missing plugin or a
  missing database: return `{ available: false, reason, generatedAt: Date.now(), total: 0, counts: {…0}, projects: [], columns: [] }`.
- Locate the plugin folder: `process.env.WC_TICKETS_PLUGIN` first, then `<repoRoot>/plugins/waifufy-tickets`
  (repo root = one level above `link/`, resolved from this module's own URL so it works whatever the cwd is).
- Load it with a **variable** dynamic import (`const mod = await import(url)`) so `tsc` does not try to
  compile the plugin's `.mjs`. Cache the resolved store; re-resolve on failure.
- Map the store's `board()` output onto `BoardSnapshot` (status order, labels, hints come from the store).
- Database path: `WC_TICKETS_DB`, else `<config>/waifufy-tickets/kanban.db`. If the file does not exist,
  return `available: true` with an empty board (an installed plugin with no tickets yet is normal).
- Read-only intent: this module must not mutate tickets.

### 2.3 `link/src/server.ts`

```ts
case 'tickets': {
  need(m.project === undefined || isStr(m.project), 'project')
  return sendTo(ws, { t: 'tickets', board: await ticketBoard(m.project) })
}
```

### 2.4 `Settings.plugins` (declared in `link/src/protocol.ts`)

The `Settings` type lives in `link/src/protocol.ts`, not in `settings.ts` — add the field there:

```ts
/** Enabled UI plugins by id (app/src/plugins), e.g. `tickets`. Missing or false means off. */
plugins?: Record<string, boolean>
```

Default it to `{}` in `link/src/settings.ts`'s `defaultSettings` (that file holds the values, `protocol.ts` the
types). Preserve unknown ids: the existing merge keeps stored keys, so an id the app does not know survives a
save. The ticket id is exactly `tickets`.

## 3. App side (owner: app-panel)

### 3.1 `app/src/plugins/index.ts` (new) — the seam

```ts
export interface UiPlugin {
  id: string                 // settings key under `plugins`
  name: string
  description: string
  defaultEnabled: boolean    // false for tickets
  mount(host: HTMLElement): () => void   // returns an unmount/cleanup fn
}
export const UI_PLUGINS: UiPlugin[]      // registry; tickets is the first entry
export function pluginEnabled(settings: Settings, id: string): boolean  // settings.plugins?.[id] === true
```

The panel module registers itself here. The registry exists so a second panel is a file plus an entry —
no other app file needs to know about tickets.

### 3.2 `app/src/chat/tickets.ts` + `tickets.css` (new)

- `mountTicketsPanel(host)` renders the card and returns a cleanup function.
- On mount: `link.send({ t: 'tickets' })`, await `{ t: 'tickets' }` via `link.next(...)` (`Link` from
  `app/src/contracts.ts`). Re-fetch when the panel's refresh button is clicked and on `turn_end`
  (a finish may have moved cards) — subscribe with `link.on(...)`, and unsubscribe in cleanup.
- Render: one group per column with a header (`label`, count) and a scrollable list of cards; the group
  body scrolls, the card overall does not grow past its allotted height. Collapse `done` by default.
- Card: `id`, title, priority marker (`!`/`!!`), project + labels + relative age, and `blockedReason`
  when blocked. Click a card to expand `body` inline (already in the snapshot — no request).
- Empty/absent states: no tickets at all ⇒ one quiet line; `available: false` ⇒ show `reason` and the
  install command `node plugins/waifufy-tickets/install.mjs` in a hint.
- `data-test` hooks (required): `tickets-panel`, `tickets-count`, `tickets-column`, `tickets-card`,
  `tickets-empty`, `tickets-unavailable`, `tickets-refresh`.

### 3.3 Mounting

- `app/src/chat/index.ts`: mount only when `pluginEnabled(settings, 'tickets')`, at the position below
  the mode/model row on the left; unmount on teardown so leaving the chat screen removes it.
- Placement must respect the existing invariants (read `docs/V1.md`): fixed 1600×900 stage, the
  `#stage[data-scale]` scale factor, z-order `#chara` (z1) < screen content (z2+), and `.screen`
  pointer-events rules. Do not overlap the character or the composer.
- All colors from `app/src/theme.css` tokens — never a raw color, so dark mode keeps working.

### 3.4 `app/src/screens/settings.ts`

Add a **Plugins** section that lists `UI_PLUGINS` with a checkbox per plugin (label + description),
persisting through the normal settings save path (`plugins[id] = checked`). Tickets is unchecked by
default. Changing it must take effect without a restart where cheap; otherwise say so in the row.

## 4. Not in v0

- No write actions from the panel, no new screens, no board-in-a-window.
- No per-project concurrency, no dispatcher, no verify gate (that is the loop, phase 2).
- No bundling into the installer: the plugin stays a folder the agent installs.

## 5. How each side is verified

- link-bridge: `npm run check` green; a hand-driven check that `{t:'tickets'}` answers with
  `available: false` when `WC_TICKETS_PLUGIN` points nowhere, and with a real board when it points at
  this folder and `WC_TICKETS_DB` names a database seeded by `bin/tickets.mjs add`.
- app-panel: `npm run check` green; panel renders the seeded board, hides when the flag is off,
  and shows the unavailable hint when link reports `available: false`.
