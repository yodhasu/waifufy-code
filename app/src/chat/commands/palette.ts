import { esc } from '../../ui'
import { openMenu, type MenuRow, type MenuScreen } from '../menu'
import { APP_COMMANDS, type CommandHost } from './index'

// The Ctrl+K command palette (docs/research/ux-research.md P0-10): every app command, the CLI's own commands and
// the chat's key actions in one searchable VN menu, most recently used first. And the CLI's `?` shortcut sheet
// (docs/research/cli-input.md §1.2), in its wording where the app has the same key, plus the VN's own keys.

const RECENT_KEY = 'wc.palette.recent'
const RECENT_MAX = 8

/**
 * The chat's key actions. `run` is the slash command that does the same thing; without one the row is a hint
 * (shown with its key, not pickable): those keys only make sense from the chat itself.
 */
const ACTIONS: { id: string; label: string; key: string; hint: string; run?: string }[] = [
  { id: 'backlog', label: 'Backlog', key: 'Ctrl+O', hint: 'The full trace: every line, tool call and output' },
  { id: 'mode', label: 'Cycle mode', key: 'Shift+Tab', hint: 'Default → Accept edits → Plan mode' },
  { id: 'background', label: 'Background', key: 'Ctrl+B', hint: 'Send the running command or agent to the background' },
  { id: 'tasks', label: 'Background tasks', key: '/tasks', hint: 'View and manage everything running in the background', run: '/tasks' },
  { id: 'rewind', label: 'Rewind', key: 'Esc Esc', hint: 'Restore the code and/or conversation to a previous point', run: '/rewind' },
  { id: 'history', label: 'History', key: 'Ctrl+R', hint: 'Search the prompts you sent' },
  { id: 'interrupt', label: 'Interrupt', key: 'Esc · Ctrl+C', hint: 'Stop her turn' },
  { id: 'costume', label: 'Costume', key: '/costume', hint: 'Open the wardrobe', run: '/costume' },
  { id: 'settings', label: 'Settings', key: '/config', hint: 'Open settings', run: '/config' },
  { id: 'theme', label: 'Theme', key: '/theme', hint: 'Light, dark, accent', run: '/theme' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', key: '?', hint: 'The shortcut sheet' },
  { id: 'paste', label: 'Paste an image', key: 'Ctrl+V · Alt+V', hint: 'Attach an image from the clipboard' },
  { id: 'clear-prompt', label: 'Clear the prompt', key: 'Ctrl+L', hint: 'Empty the composer' },
]

function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveRecent(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)))
  } catch {
    // Storage blocked: the ranking is a convenience, the palette still works.
  }
}

/** A palette row and what Enter does with it: run a line, or put a command that needs an argument in the composer. */
type Item = MenuRow & { line?: string; draft?: boolean }

function items(host: CommandHost): { title: string; rows: Item[] }[] {
  const waifu = host.charName()
  const app: Item[] = APP_COMMANDS.map((c) => ({
    id: `app:${c.name}`,
    label: `/${c.name}${c.hint ? ` ${c.hint}` : ''}`,
    hint: c.describe(waifu),
    meta: c.aliases.length ? c.aliases.map((a) => `/${a}`).join(' ') : undefined,
    line: `/${c.name}`,
    draft: c.hint.startsWith('<'),
  }))
  const own = new Set(APP_COMMANDS.flatMap((c) => [c.name, ...c.aliases]))
  const cli: Item[] = host
    .commands()
    .filter((c) => !own.has(c.name))
    .map((c) => ({
      id: `cli:${c.name}`,
      label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
      hint: c.description,
      meta: c.aliases?.length ? c.aliases.map((a) => `/${a}`).join(' ') : undefined,
      line: `/${c.name}`,
      draft: c.argumentHint.startsWith('<'),
    }))
  const keys: Item[] = ACTIONS.map((a) => ({
    id: `key:${a.id}`,
    label: a.label,
    hint: a.hint,
    meta: a.key,
    icon: a.run ? '' : '⌨',
    tone: 'muted',
    disabled: !a.run && a.id !== 'shortcuts',
    line: a.run,
  }))
  return [
    { title: 'Actions', rows: keys },
    { title: 'App commands', rows: app },
    { title: 'Claude Code commands', rows: cli },
  ]
}

function paletteScreen(host: CommandHost): MenuScreen {
  const groups = items(host)
  const all = new Map(groups.flatMap((g) => g.rows).map((r) => [r.id, r]))
  // Most recently used first, in their own group so each row keeps one id.
  const recent = loadRecent().map((id) => all.get(id)).filter((r): r is Item => !!r && !r.disabled)
  const used = new Set(recent.map((r) => r.id))
  return {
    title: 'Commands',
    subtitle: 'Every command and action, with its key',
    search: true,
    groups: [
      ...(recent.length ? [{ title: 'Recent', rows: recent }] : []),
      ...groups.map((g) => ({ title: g.title, rows: g.rows.filter((r) => !used.has(r.id)) })).filter((g) => g.rows.length),
    ],
    notes: ['Rows with ⌨ are keys: press them in the chat'],
    pick(row) {
      const it = all.get(row.id)
      if (!it) return
      saveRecent(it.id)
      // Close first, so whatever the command opens lands on top of the chat rather than under the palette.
      setTimeout(() => {
        if (it.id === 'key:shortcuts') openShortcuts(host)
        else if (it.draft && it.line) host.setDraft(`${it.line} `)
        else if (it.line) host.run(it.line)
      }, 0)
      return 'close'
    },
  }
}

/** Ctrl+K: the command palette, with the search box focused. */
export function openPalette(host: CommandHost) {
  const m = openMenu(host, 'palette', paletteScreen(host), 'Commands')
  m.el.classList.add('palette')
  // The first screen is drawn on the next microtask; focus its search box once it exists.
  setTimeout(() => m.el.querySelector<HTMLInputElement>('[data-test="menu-search"]')?.focus(), 0)
}

// The CLI's `?` panel, column by column, in its wording. Keys the app does differently say what the app does.
const SHEET: { title?: string; rows: [string, string][] }[][] = [
  [
    {
      rows: [
        ['!', 'for shell mode'],
        ['/', 'for commands'],
        ['@', 'for file paths'],
        ['double tap esc', 'to rewind'],
        ['esc', 'to interrupt'],
      ],
    },
  ],
  [
    {
      rows: [
        ['shift + tab', 'to cycle modes (auto-accept edits, plan)'],
        ['ctrl + o', 'for verbose output (the backlog)'],
        ['ctrl + b', 'to run in background'],
        ['ctrl + r', 'to search history'],
        ['ctrl + k', 'for every command'],
      ],
    },
  ],
  [
    {
      rows: [
        ['alt + v', 'to paste images'],
        ['shift + enter', 'for newline'],
        ['ctrl + l', 'to clear input'],
        ['ctrl + enter', 'to send now'],
        ['/model', 'to switch model'],
        ['/fast', 'to toggle fast mode'],
      ],
    },
  ],
]

/** `?` on an empty prompt: the shortcut sheet. Read-only; Esc closes it. */
export function openShortcuts(host: CommandHost) {
  const vn: [string, string][] = [
    ['click · space', 'to advance'],
    ['hold ctrl', 'to skip'],
    ['AUTO', 'to read on by itself'],
    ['LOG', 'for the backlog'],
    ['1–9', 'to answer a choice'],
    ['👗', `to change ${host.charName()}'s costume`],
  ]
  const row = ([k, v]: [string, string]) => `<div class="hk"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`
  const col = (sections: { title?: string; rows: [string, string][] }[]) =>
    `<section>${sections.map((s) => (s.title ? `<h3>${esc(s.title)}</h3>` : '') + s.rows.map(row).join('')).join('')}</section>`
  const body = `<div class="help shortcuts">${SHEET.map(col).join('')}</div>`
    + `<h3 class="sc-title">Visual novel</h3><div class="help shortcuts">${col([{ rows: vn.slice(0, 2) }])}${col([{ rows: vn.slice(2, 4) }])}${col([{ rows: vn.slice(4) }])}</div>`
    + '<p class="sc-foot">Esc to close · /help for every command</p>'
  host.modal({ test: 'shortcuts', title: 'Shortcuts', cls: 'wide', body })
}
