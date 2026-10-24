import { esc } from '../../ui'
import { control } from '../control'
import { detailRows, openMenu, type MenuResult, type MenuRow, type MenuScreen } from '../menu'
import type { CommandHost } from './index'

// /memory, as the CLI 2.1.309 draws it (docs/research/cli-extensions.md §6): the Auto-memory and Auto-dream toggles
// (saved to the user settings, like the CLI's Hn("userSettings")), then the instruction files with their
// @-imports, then the auto-memory folder. Headless /config has no row for either toggle, so they go through
// editSettings. Opening a file shows it in Explorer: the link has no "open in editor" or "create file" op yet.

type SettingsFile = { source: 'user' | 'project' | 'local'; path: string; exists: boolean; json: Record<string, unknown>; error?: string }

/** A file row: `depth` > 0 is an @-import of the row above it. */
type MemFile = { kind: 'user' | 'project' | 'other'; path: string; depth: number; text?: string; exists: boolean }

type State = { files: SettingsFile[]; claudeDir: string; mem: MemFile[]; git: boolean; autoDir?: { path: string; exists: boolean } }

const DOCS = 'https://code.claude.com/docs/en/memory'
const PREVIEW_LINES = 12
/** How deep the CLI follows @-imports. */
const IMPORT_DEPTH = 5

const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/')
const join = (base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ''), ...parts].join(sepOf(base))
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
const isAbs = (p: string) => /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
const same = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

/** Resolves `p` against `dir`, folding `.` and `..`, in `dir`'s separator style. */
function resolve(dir: string, p: string, home: string) {
  const sep = sepOf(dir)
  const full = p.startsWith('~') ? home + p.slice(1) : isAbs(p) ? p : `${dir}${sep}${p}`
  const out: string[] = []
  for (const part of full.split(/[\\/]+/)) {
    if (part === '..') out.pop()
    else if (part !== '.') out.push(part)
  }
  return out.join(sep)
}

function size(text: string) {
  const bytes = new TextEncoder().encode(text).length
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

/** Reads a text file through the link: its text, `null` when missing, `dir` for a folder, or `error` (outside the allowed folders). */
async function probe(host: CommandHost, path: string): Promise<string | null | 'dir' | 'error'> {
  try {
    return (await control<string | undefined>(host.link, 'readText', path)) ?? null
  } catch (e) {
    return /EISDIR/.test(String(e instanceof Error ? e.message : e)) ? 'dir' : 'error'
  }
}

/** The `@path` imports in a memory file, outside code blocks and inline code, as the CLI reads them. */
function imports(text: string) {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  return [...prose.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)].map((m) => m[1].replace(/\\ /g, ' ').replace(/[.,;:!?)\]]+$/, '')).filter(Boolean)
}

/** The setting as the CLI sees it: local over project over user. */
function setting(files: SettingsFile[], key: string): { value: unknown; from?: SettingsFile['source'] } {
  for (const s of ['local', 'project', 'user'] as const) {
    const f = files.find((x) => x.source === s)
    if (f && key in f.json) return { value: f.json[key], from: s }
  }
  return { value: undefined }
}

async function load(host: CommandHost): Promise<State> {
  const cwd = host.cwd()
  const files = await control<SettingsFile[]>(host.link, 'settingsFiles')
  const claudeDir = dirOf(files.find((f) => f.source === 'user')!.path)
  const home = /[\\/]\.claude$/i.test(claudeDir) ? dirOf(claudeDir) : '~'
  // The files the session loaded, for the ones the fixed list below doesn't name (parent folders, rules).
  const loaded = await control<{ memoryFiles?: { path: string; type: string }[] }>(host.link, 'getContextUsage').then(
    (u) => (u.memoryFiles ?? []).filter((f) => !/mem$/i.test(f.type)).map((f) => resolve(cwd, f.path, home)),
    () => [] as string[],
  )
  const mem: MemFile[] = []
  const seen = (p: string) => mem.some((m) => same(m.path, p))
  /** `always`: list it even when missing (the CLI's user and project rows); `loaded`: the session loaded it. */
  async function add(kind: MemFile['kind'], path: string, depth: number, mode: 'always' | 'if-exists' | 'loaded') {
    if (seen(path)) return
    const text = await probe(host, path)
    const exists = typeof text === 'string' && text !== 'dir' && text !== 'error'
    // A loaded file outside the project and the Claude folder can't be read here, but it exists.
    const unreadable = text === 'error' && mode === 'loaded'
    if (!exists && !unreadable && mode !== 'always') return
    mem.push({ kind, path, depth, exists: exists || unreadable, text: exists ? text : undefined })
    if (exists && depth < IMPORT_DEPTH) for (const p of imports(text)) await add('other', resolve(dirOf(path), p, home), depth + 1, 'if-exists')
  }
  await add('user', join(claudeDir, 'CLAUDE.md'), 0, 'always')
  await add('project', join(cwd, 'CLAUDE.md'), 0, 'always')
  await add('other', join(cwd, '.claude', 'CLAUDE.md'), 0, 'if-exists')
  await add('other', join(cwd, 'CLAUDE.local.md'), 0, 'if-exists')
  for (const p of loaded) await add('other', p, 0, 'loaded')

  const git = (await probe(host, join(cwd, '.git'))) !== null
  const on = setting(files, 'autoMemoryEnabled').value !== false
  let autoDir: State['autoDir']
  if (on) {
    // autoMemoryDirectory is ignored in the checked-in project settings, as in the CLI.
    const custom = ['local', 'user'].map((s) => files.find((f) => f.source === s)?.json.autoMemoryDirectory).find((v) => typeof v === 'string') as string | undefined
    const path = custom ? resolve(cwd, custom, home) : join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
    autoDir = { path, exists: (await probe(host, path)) === 'dir' }
  }
  return { files, claudeDir, mem, git, autoDir }
}

/** Opens /memory. */
export function memoryCommand(host: CommandHost, _args: string, _typed: string) {
  let opened = false
  const onOpen = () => (opened = true)
  const menu = openMenu(host, 'memory', load(host).then((s) => listScreen(host, s, onOpen)), 'Memory')
  void menu.closed.then(() => opened || host.toast('Cancelled memory editing'))
}

/** A file's path as the CLI lists it: relative to the project, or under ~. */
function shortPath(host: CommandHost, s: State, p: string) {
  const cwd = host.cwd()
  if (p.toLowerCase().startsWith(cwd.toLowerCase() + sepOf(cwd))) return p.slice(cwd.length + 1)
  const home = dirOf(s.claudeDir)
  return p.toLowerCase().startsWith(home.toLowerCase() + sepOf(home)) ? `~${p.slice(home.length)}` : p
}

function fileRow(host: CommandHost, s: State, f: MemFile, i: number): MenuRow {
  const name = shortPath(host, s, f.path)
  const label = f.kind === 'user' ? 'User instructions' : f.kind === 'project' ? 'Project instructions' : f.depth > 0 ? `${'  '.repeat(f.depth - 1)}L ${name}` : name
  const hint = f.kind === 'user' ? 'Saved in ~/.claude/CLAUDE.md'
    : f.kind === 'project' ? `${s.git ? 'Checked in at' : 'Saved in'} ./CLAUDE.md`
    : f.depth > 0 ? '@-imported' : undefined
  return { id: `file:${i}`, label, hint, meta: !f.exists ? 'not created yet' : f.text !== undefined ? size(f.text) : 'loaded' }
}

function listScreen(host: CommandHost, s: State, onOpen: () => void): MenuScreen {
  const mem = setting(s.files, 'autoMemoryEnabled')
  const dream = setting(s.files, 'autoDreamEnabled')
  const memOn = mem.value !== false
  const elsewhere = (x: { from?: string }) => (x.from && x.from !== 'user' ? `set in ${x.from} settings` : undefined)
  const toggle = (id: string, label: string, on: boolean, extra: Partial<MenuRow>): MenuRow =>
    ({ id, label, icon: on ? '✔' : '◯', tone: on ? 'ok' : 'muted', meta: on ? 'on' : 'off', ...extra })
  const toggles: MenuRow[] = [
    toggle('auto-memory', 'Auto-memory', memOn, { hint: elsewhere(mem) }),
    memOn
      ? toggle('auto-dream', 'Auto-dream', dream.value === true, {
        meta: dream.value === undefined ? 'default' : dream.value ? 'on' : 'off',
        hint: elsewhere(dream) ?? (dream.value === undefined ? 'not set · the server decides' : undefined),
      })
      : toggle('auto-dream', 'Auto-dream', false, { hint: 'off while auto-memory is off', disabled: true }),
  ]
  const folders: MenuRow[] = s.autoDir
    ? [{ id: 'folder:auto', label: 'Open auto-memory folder', disabled: !s.autoDir.exists, hint: s.autoDir.exists ? undefined : 'not created yet: Claude makes it on its first memory' }]
    : []
  const flip = async (row: MenuRow): Promise<MenuResult> => {
    const key = row.id === 'auto-memory' ? 'autoMemoryEnabled' : 'autoDreamEnabled'
    const now = row.id === 'auto-memory' ? memOn : dream.value === true
    await control(host.link, 'editSettings', 'user', [{ op: 'set', path: [key], value: !now }])
    return 'refresh'
  }
  return {
    title: 'Memory',
    groups: [{ rows: toggles }, { rows: s.mem.map((f, i) => fileRow(host, s, f, i)) }, ...(folders.length ? [{ rows: folders }] : [])],
    notes: [`Learn more: ${DOCS}`, 'Space to toggle'],
    reload: async () => listScreen(host, await load(host), onOpen),
    key(e, row) {
      if (e.key === ' ' && row && (row.id === 'auto-memory' || row.id === 'auto-dream')) return row.disabled ? true : flip(row)
      return false
    },
    pick(row) {
      if (row.id === 'auto-memory' || row.id === 'auto-dream') return flip(row)
      if (row.id === 'folder:auto' && s.autoDir) return reveal(host, s.autoDir.path, onOpen)
      const f = s.mem[Number(row.id.slice('file:'.length))]
      return f && fileScreen(host, s, f, onOpen)
    },
  }
}

/** Shows `path` in Explorer, selected. */
function reveal(host: CommandHost, path: string, onOpen: () => void): MenuResult {
  onOpen()
  host.link.send({ t: 'reveal', path })
  host.toast(`Opened ${path} in Explorer`)
  return 'close'
}

/** Opens `path` in its default app: the desktop's stand-in for the CLI's $VISUAL / $EDITOR. */
function openFile(host: CommandHost, path: string, onOpen: () => void): MenuResult {
  onOpen()
  host.link.send({ t: 'open', target: path })
  host.toast(`Opened ${path}`)
  return 'close'
}

/** The CLI creates a missing memory file before opening it; so does this, with a heading to start from. */
async function create(host: CommandHost, path: string, onOpen: () => void): Promise<MenuResult> {
  const made = await control<string>(host.link, 'createText', path, '# Instructions for Claude\n\n')
  return openFile(host, made, onOpen)
}

function fileScreen(host: CommandHost, s: State, f: MemFile, onOpen: () => void): MenuScreen {
  const lines = f.text?.split(/\r?\n/) ?? []
  const preview = f.text === undefined ? ''
    : f.text.trim() ? `<pre class="mmem-preview">${esc(lines.slice(0, PREVIEW_LINES).join('\n'))}${lines.length > PREVIEW_LINES ? '\n…' : ''}</pre>`
    : '<p class="mmem-note">(empty)</p>'
  const row = fileRow(host, s, f, 0)
  const rows: MenuRow[] = f.exists
    ? [{ id: 'open', label: 'Open in your editor', hint: 'Its default app for .md files' }, { id: 'reveal', label: 'Show in Explorer' }]
    : [{ id: 'create', label: 'Create it and open it' }]
  return {
    title: row.label.trim(),
    subtitle: row.hint,
    body: detailRows([
      ['Path:', f.path],
      ['Status:', !f.exists ? 'Not created yet' : f.text !== undefined ? `${size(f.text)} · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}` : 'Loaded (outside this project, so it can\'t be previewed)'],
    ]) + preview,
    groups: [{ rows }],
    pick: (r) => (r.id === 'open' ? openFile(host, f.path, onOpen) : r.id === 'reveal' ? reveal(host, f.path, onOpen) : r.id === 'create' ? create(host, f.path, onOpen) : undefined),
  }
}
