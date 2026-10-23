import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSessionInfo, getSessionMessages, listSessions, renameSession, type SDKSessionInfo, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { EMOTIONS, type HistoryEntry, type Save } from './protocol.ts'
import { DATA_DIR, loadSettings } from './settings.ts'
import { clip, describeTool, toolLabel, toolOutput } from './tools.ts'

// The save registry: which sessions the app has played, plus the VN-side stats Claude Code doesn't keep
// (play time, affection, thumbnail). Transcripts stay where the CLI writes them and are never touched here.

const REGISTRY = join(DATA_DIR, 'saves.json')
/** v0 kept only `{ id, cwd, createdAt }[]` here. */
const LEGACY_REGISTRY = join(DATA_DIR, 'sessions.json')
export const THUMBS_DIR = join(DATA_DIR, 'thumbs')

const HISTORY_LIMIT = 300
const TITLE_MAX = 80
const LAST_LINE_MAX = 400
const AFFECTION_MAX = 5
const THUMB_MAX_BYTES = 4 * 1024 * 1024
/** A registered session that still has no transcript after this long never got a first message: it is dropped. */
const PRUNE_AFTER_MS = 24 * 60 * 60_000
/** Terminal sessions listed per project folder, newest first. */
const DISCOVER_PER_DIR = 50
/**
 * Whether the Load page also lists sessions started in a terminal (`claude`) in the folders the app knows.
 * Off for v1: the product decision is that only sessions started in Waifufy Code are saves.
 */
const INCLUDE_TERMINAL_SESSIONS = false
/** Mock sessions (WC_MOCK=1, the E2E harness) never write a transcript, so the registry alone describes them. */
const MOCK = process.env.WC_MOCK === '1'
const MOCK_TITLE = 'Mock session'
/** Session ids are UUIDs; anything else must never reach a file path. */
const ID_RE = /^[\w-]{1,80}$/

type Entry = {
  id: string
  cwd: string
  createdAt: number
  playMs: number
  turns: number
  affection: number
  costume?: string
  lastLine?: string
  /** Set by rename; wins over the transcript's own title, so a rename sticks even if renameSession failed. */
  title?: string
  /** Bumped on every thumbnail write, for cache busting. 0 = no thumbnail. */
  thumbV: number
  /** Last time the app recorded something for it; stands in for the transcript's mtime in mock mode. */
  updatedAt: number
}

/** `hidden`: deleted saves. Their transcripts stay, so without this a terminal session would come straight back. */
type Registry = { version: 1; saves: Entry[]; hidden: string[] }

export function isSaveId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function newEntry(id: string, cwd: string, createdAt = Date.now()): Entry {
  return { id, cwd, createdAt, playMs: 0, turns: 0, affection: 0, thumbV: 0, updatedAt: createdAt }
}

let registry: Promise<Registry> | undefined
/** Mutations run one after another, so two quick save_meta messages can't lose each other's write. */
let queue: Promise<unknown> = Promise.resolve()

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function loadRegistry(): Promise<Registry> {
  if (existsSync(REGISTRY)) {
    try {
      const raw = (await readJson(REGISTRY)) as Partial<Registry>
      const saves = Array.isArray(raw.saves) ? raw.saves.filter((e) => isSaveId(e?.id) && typeof e.cwd === 'string') : []
      const hidden = Array.isArray(raw.hidden) ? raw.hidden.filter(isSaveId) : []
      return { version: 1, saves: saves.map((e) => ({ ...newEntry(e.id, e.cwd, e.createdAt), ...e })), hidden }
    } catch (e) {
      // Keep the broken file for inspection instead of overwriting the user's saves with nothing.
      const backup = `${REGISTRY}.broken-${Date.now()}`
      console.error(`[saves] ${REGISTRY} is unreadable (${errorText(e)}); moved it to ${backup}`)
      await rename(REGISTRY, backup).catch(() => {})
      return { version: 1, saves: [], hidden: [] }
    }
  }
  const migrated: Registry = { version: 1, saves: [], hidden: [] }
  if (existsSync(LEGACY_REGISTRY)) {
    try {
      const legacy = (await readJson(LEGACY_REGISTRY)) as { id?: string; cwd?: string; createdAt?: number }[]
      for (const e of Array.isArray(legacy) ? legacy : []) {
        if (isSaveId(e.id) && typeof e.cwd === 'string' && !migrated.saves.some((s) => s.id === e.id)) {
          migrated.saves.push(newEntry(e.id, e.cwd, e.createdAt ?? Date.now()))
        }
      }
      await writeRegistry(migrated)
      console.log(`[saves] migrated ${migrated.saves.length} sessions from ${LEGACY_REGISTRY}`)
    } catch (e) {
      console.error(`[saves] could not migrate ${LEGACY_REGISTRY}: ${errorText(e)}`)
    }
  }
  return migrated
}

async function writeRegistry(r: Registry) {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${REGISTRY}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(r, null, 2) + '\n')
  await rename(tmp, REGISTRY)
}

function getRegistry() {
  registry ??= loadRegistry()
  return registry
}

function mutate<T>(fn: (r: Registry) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const r = await getRegistry()
    const out = await fn(r)
    await writeRegistry(r)
    return out
  })
  queue = run.catch(() => {})
  return run
}

/** Records a session the app played. Called when the CLI reports its id, including the new id after /clear. */
export function remember(id: string, cwd: string) {
  if (!isSaveId(id)) return Promise.resolve()
  return mutate((r) => {
    if (r.hidden.includes(id)) return
    const e = r.saves.find((s) => s.id === id)
    if (e) e.updatedAt = Date.now()
    else r.saves.push(newEntry(id, cwd))
  })
}

/** Loading a deleted save on purpose (a resume by id) brings it back to the list. */
export function unhide(id: string) {
  return mutate((r) => {
    r.hidden = r.hidden.filter((h) => h !== id)
  })
}

function toSave(e: Entry, info: SDKSessionInfo | undefined): Save {
  const cwd = info?.cwd || e.cwd
  return {
    id: e.id,
    title: cleanTitle(e.title || info?.customTitle || info?.summary || info?.firstPrompt || '') || 'Untitled',
    cwd,
    cwdShort: shortPath(cwd),
    branch: info?.gitBranch && info.gitBranch !== 'HEAD' ? info.gitBranch : undefined,
    createdAt: e.createdAt || info?.createdAt || 0,
    lastModified: info?.lastModified ?? e.createdAt,
    playMs: e.playMs,
    turns: e.turns,
    affection: e.affection,
    costume: e.costume,
    thumb: e.thumbV > 0 ? `/thumbs/${e.id}.jpg?v=${e.thumbV}` : undefined,
    lastLine: e.lastLine,
  }
}

type Lookup = { info?: SDKSessionInfo; failed: boolean }

/** The transcript's metadata. `failed` (the SDK threw) is kept apart from "no transcript", so an error never prunes a save. */
async function lookup(e: Entry): Promise<Lookup> {
  try {
    // Without `dir` the SDK looks in every project folder, so a worktree or a differently spelled path still matches.
    const info = (await getSessionInfo(e.id, { dir: e.cwd })) ?? (await getSessionInfo(e.id))
    if (!info && MOCK) return { info: { sessionId: e.id, summary: e.title || e.lastLine || MOCK_TITLE, lastModified: e.updatedAt }, failed: false }
    return { info, failed: false }
  } catch (err) {
    console.warn(`[saves] getSessionInfo ${e.id}: ${errorText(err)}`)
    return { failed: true }
  }
}

const folded = (p: string) => {
  const s = p.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** Sessions run in a terminal (`claude`) in the folders the app knows, as the CLI's own `/resume` lists them. */
async function discover(dirs: string[]): Promise<SDKSessionInfo[]> {
  const unique = [...new Map(dirs.filter(Boolean).map((d) => [folded(d), d])).values()]
  const lists = await Promise.all(
    unique.map((dir) =>
      // Like the terminal picker, programmatic sessions are left out; that also hides the app's own research runs.
      listSessions({ dir, limit: DISCOVER_PER_DIR, includeProgrammatic: false }).catch((err) => {
        console.warn(`[saves] listSessions ${dir}: ${errorText(err)}`)
        return []
      }),
    ),
  )
  return lists.flat()
}

/**
 * Every save whose transcript still exists, newest first: the sessions the app played (with their VN stats),
 * plus, when INCLUDE_TERMINAL_SESSIONS is on, terminal sessions in the same folders (with zeroed stats).
 * A registered session without a transcript is hidden; once it is older than PRUNE_AFTER_MS it never got a
 * first message and is dropped.
 */
export async function listSaves(): Promise<Save[]> {
  await queue
  const { saves, hidden } = await getRegistry()
  const settings = await loadSettings()
  const [found, terminal] = await Promise.all([
    Promise.all(saves.map(async (e) => ({ e, ...(await lookup(e)) }))),
    // Mock runs list only the app's own saves, so E2E counts don't depend on this machine's transcripts.
    MOCK || !INCLUDE_TERMINAL_SESSIONS ? [] : discover([...saves.map((e) => e.cwd), settings.lastDir, settings.claude.defaultDir]),
  ])
  const stale = new Set(found.filter((f) => !f.info && !f.failed && !MOCK && Date.now() - f.e.createdAt > PRUNE_AFTER_MS).map((f) => f.e.id))
  if (stale.size) {
    void mutate((r) => {
      r.saves = r.saves.filter((s) => !stale.has(s.id))
    }).catch((err) => console.warn(`[saves] prune: ${errorText(err)}`))
  }
  const byId = new Map<string, Save>()
  for (const f of found) if (f.info) byId.set(f.e.id, toSave(f.e, f.info))
  for (const info of terminal) {
    if (byId.has(info.sessionId) || hidden.includes(info.sessionId) || !isSaveId(info.sessionId)) continue
    byId.set(info.sessionId, toSave(newEntry(info.sessionId, info.cwd ?? '', 0), info))
  }
  return [...byId.values()].sort((a, b) => b.lastModified - a.lastModified)
}

/** One save, for the `started` event of a resume. */
export async function getSave(id: string, cwd: string): Promise<Save | undefined> {
  await queue
  const { saves } = await getRegistry()
  const e = saves.find((s) => s.id === id) ?? newEntry(id, cwd, 0)
  const { info } = await lookup(e)
  return info ? toSave(e, info) : undefined
}

export async function renameSave(id: string, title: string) {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  await queue
  // A terminal session isn't registered yet; renaming adopts it, so the title override has somewhere to live.
  const known = (await getRegistry()).saves.find((s) => s.id === id)
  const cwd = known?.cwd ?? (await getSessionInfo(id).catch(() => undefined))?.cwd
  if (!cwd) throw new Error('That save no longer exists.')
  await mutate((r) => {
    let e = r.saves.find((s) => s.id === id)
    if (!e) {
      e = newEntry(id, cwd)
      r.saves.push(e)
    }
    e.title = clean || undefined
  })
  // Also write it into the transcript, so `claude --resume` in a terminal shows the same title.
  if (clean && !MOCK) {
    await renameSession(id, clean, { dir: cwd }).catch((e) => console.warn(`[saves] renameSession ${id}: ${errorText(e)}`))
  }
}

/** Removes the save from the app's list and its thumbnail. The transcript stays on disk (R8). */
export async function deleteSave(id: string) {
  await mutate((r) => {
    r.saves = r.saves.filter((s) => s.id !== id)
    // Hidden until resumed on purpose, so neither a terminal listing nor the running session's next save_meta brings it back.
    if (!r.hidden.includes(id)) r.hidden.push(id)
  })
  await rm(join(THUMBS_DIR, `${id}.jpg`), { force: true })
}

export type MetaPatch = Partial<Pick<Save, 'playMs' | 'turns' | 'affection' | 'costume' | 'lastLine'>>

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined)

/** Updates play stats of a save; `thumb` is a JPEG data URL. `cwd` creates the entry if the session wasn't recorded yet. */
export async function saveMeta(id: string, patch: MetaPatch, thumb?: string, cwd?: string) {
  let jpeg: Buffer | undefined
  if (thumb) {
    const m = /^data:image\/jpe?g;base64,(.+)$/s.exec(thumb)
    if (!m) throw new Error('The thumbnail must be a JPEG data URL.')
    jpeg = Buffer.from(m[1], 'base64')
    if (jpeg.length > THUMB_MAX_BYTES) throw new Error('The thumbnail is too large.')
  }
  // The thumbnail is written inside the queue too, so updates land in the order they were sent.
  await mutate(async (r) => {
    if (r.hidden.includes(id)) return
    let e = r.saves.find((s) => s.id === id)
    if (!e) {
      if (!cwd) return
      e = newEntry(id, cwd)
      r.saves.push(e)
    }
    if (jpeg) {
      await mkdir(THUMBS_DIR, { recursive: true })
      const file = join(THUMBS_DIR, `${id}.jpg`)
      await writeFile(`${file}.tmp`, jpeg)
      await rename(`${file}.tmp`, file)
    }
    const playMs = count(patch.playMs)
    const turns = count(patch.turns)
    const affection = count(patch.affection)
    if (playMs !== undefined) e.playMs = playMs
    if (turns !== undefined) e.turns = turns
    if (affection !== undefined) e.affection = Math.min(AFFECTION_MAX, affection)
    if (typeof patch.costume === 'string') e.costume = patch.costume
    if (typeof patch.lastLine === 'string') e.lastLine = stripTags(patch.lastLine).trim().slice(0, LAST_LINE_MAX)
    if (jpeg) e.thumbV += 1
    e.updatedAt = Date.now()
  })
}

// ---------------------------------------------------------------- history

const TAGS = new RegExp(`[ \\t]*\\[(?:${EMOTIONS.join('|')})\\][ \\t]*`, 'gi')
/** `[smile] Hi! [happy]Done [nod].` → `Hi! Done.`: one space stays between words, none at an edge or before punctuation. */
const stripTags = (text: string) =>
  text.replace(TAGS, (m: string, at: number, s: string) => {
    const before = s[at - 1]
    const after = s[at + m.length]
    return before && after && !/\s/.test(before) && !/[\s.,!?;:…)]/.test(after) ? ' ' : ''
  })
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const COMPACTED = 'Conversation compacted. Earlier lines are summarized.'
const INTERRUPTED = 'Interrupted.'
/** The CLI's synthetic placeholder reply (for example after a local command); noise in the backlog. */
const NO_RESPONSE = 'No response requested.'
/** Wrapper tags the CLI puts around commands, pastes and reminders in first prompts. Other `<…>` text is the user's own. */
const WRAPPER_TAGS = /<\/?(?:command-[\w-]+|local-command-[\w-]+|bash-[\w-]+|system-reminder|pasted_content)[^>]*>/g
/** User-role text the harness injects (hooks, background tasks, subagent hand-backs). Never something the user typed. */
const HARNESS_TAGS = ['task-notification', 'agent-message', 'user-prompt-submit-hook', 'artifact-content-authored-by-others']
/** Wrappers whose content is for the model only; removed before a line is read. */
const HIDDEN = /<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/g

/** Extra transcript flags the SDK passes through but doesn't type. */
type Flags = { is_meta?: boolean; isMeta?: boolean; isCompactSummary?: boolean; origin?: { kind?: string } }
type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
type ToolEntry = Extract<HistoryEntry, { who: 'tool' }>

function tagged(text: string, tag: string) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return m ? m[1] : undefined
}

const toRecord = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]).filter((b) => b && typeof b === 'object') : []
}

const output = (text: string): HistoryEntry[] => {
  const out = text.replace(ANSI, '').trim()
  return out ? [{ who: 'system', text: clip(out) }] : []
}

/**
 * Turns one user-role text into backlog lines: typed prompts, slash commands with their output, and `!`
 * commands with theirs (shell.ts records input and output together, the CLI in two messages).
 */
function userLines(raw: string): HistoryEntry[] {
  const text = raw.replace(HIDDEN, '').trim()
  if (!text) return []
  if (text.startsWith('[Request interrupted')) return [{ who: 'system', text: INTERRUPTED }]
  const opener = /^<([\w-]+)/.exec(text)?.[1]
  if (opener && HARNESS_TAGS.includes(opener)) return []
  const lines: HistoryEntry[] = []
  const command = tagged(text, 'command-name')
  const bash = tagged(text, 'bash-input')
  const stdout = tagged(text, 'local-command-stdout') ?? tagged(text, 'local-command-stderr')
  const bashOut = tagged(text, 'bash-stdout')
  if (command !== undefined) {
    const args = tagged(text, 'command-args')?.trim() ?? ''
    lines.push({ who: 'user', text: `${command.trim()}${args ? ' ' + args : ''}` })
  }
  if (bash !== undefined) lines.push({ who: 'user', text: `!${bash.trim()}` })
  if (stdout !== undefined) lines.push(...output(stdout))
  if (bashOut !== undefined) lines.push(...output([bashOut, tagged(text, 'bash-stderr') ?? ''].join('\n')))
  if (command !== undefined || bash !== undefined || stdout !== undefined || bashOut !== undefined) return lines
  return [{ who: 'user', text: text.replace(/<\/?pasted_content[^>]*>/g, '').trim() }]
}

/** `<config>/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl`, where the CLI writes the transcript. */
async function transcriptFile(id: string, cwd: string): Promise<string | undefined> {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const direct = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  if (existsSync(direct)) return direct
  // Very long paths get a hashed folder name and worktrees have their own: look in every project.
  const dirs = await readdir(projects).catch(() => [] as string[])
  return dirs.map((d) => join(projects, d, `${id}.jsonl`)).find((f) => existsSync(f))
}

type Line = Flags & { type?: string; uuid?: string; parentUuid?: string | null; logicalParentUuid?: string | null; isSidechain?: boolean }

/**
 * The main chain the last compaction replaced, oldest first. getSessionMessages stops at the compact boundary,
 * whose `logicalParentUuid` links back to the earlier chain (and through earlier boundaries the same way).
 */
async function beforeCompaction(id: string, cwd: string, chain: SessionMessage[]): Promise<SessionMessage[]> {
  if (!chain[0] || !chain.some((m) => (m as SessionMessage & Flags).isCompactSummary)) return []
  try {
    const file = await transcriptFile(id, cwd)
    if (!file) return []
    const byUuid = new Map<string, Line>()
    for (const raw of (await readFile(file, 'utf8')).split('\n')) {
      if (!raw.trim()) continue
      try {
        const line = JSON.parse(raw) as Line
        if (line.uuid) byUuid.set(line.uuid, line)
      } catch {
        // The CLI may be mid-write on the last line.
      }
    }
    // A partial compaction keeps its newest messages verbatim; they are in the SDK's chain and in the walk, so skip them here.
    const inChain = new Set(chain.map((m) => m.uuid))
    const visited = new Set<string>()
    const earlier: Line[] = []
    let at = byUuid.get(chain[0].uuid)
    while (at) {
      const next: string | null | undefined = at.parentUuid ?? at.logicalParentUuid
      if (!next || visited.has(next)) break
      visited.add(next)
      at = byUuid.get(next)
      if (at && !inChain.has(next) && !at.isSidechain && (at.type === 'user' || at.type === 'assistant')) earlier.push(at)
    }
    return earlier.reverse().map((l) => ({ ...l, parent_tool_use_id: null }) as unknown as SessionMessage)
  } catch (e) {
    console.warn(`[saves] reading ${id} before its compaction: ${errorText(e)}`)
    return []
  }
}

/**
 * The conversation so far for the backlog (R23): both sides' lines, tool calls with their results, slash
 * command and `!` output, compactions and interruptions. Emotion tags are stripped; harness text is skipped.
 */
export async function loadHistory(id: string, cwd: string): Promise<HistoryEntry[]> {
  const chain: SessionMessage[] = await getSessionMessages(id, { dir: cwd }).catch((e) => {
    console.warn(`[saves] getSessionMessages ${id}: ${errorText(e)}`)
    return []
  })
  const messages = [...(await beforeCompaction(id, cwd, chain)), ...chain]
  const out: HistoryEntry[] = []
  const tools = new Map<string, ToolEntry>()
  const push = (e: HistoryEntry) => {
    const last = out.at(-1)
    // The CLI stores each streamed text block as its own message; one reply reads better as one line.
    if (e.who === 'char' && last?.who === 'char') last.text = `${last.text}\n\n${e.text}`
    else out.push(e)
  }

  for (const m of messages) {
    const f = m as SessionMessage & Flags
    if (m.parent_tool_use_id) continue
    // The summary is also flagged meta; the lines it replaced come from earlierChain().
    if (f.isCompactSummary) {
      push({ who: 'system', text: COMPACTED })
      continue
    }
    if (f.is_meta || f.isMeta) continue
    if (f.origin?.kind && f.origin.kind !== 'human') continue
    const message = (m.message ?? {}) as { content?: unknown; model?: string }

    if (m.type === 'assistant') {
      // The CLI's own notices (not logged in, API errors) are stored as assistant messages from '<synthetic>'.
      const synthetic = message.model === '<synthetic>'
      for (const b of blocks(message.content)) {
        if (b.type === 'text' && b.text?.trim()) {
          const text = synthetic ? b.text.trim() : stripTags(b.text).trim()
          if (synthetic && text === NO_RESPONSE) continue
          if (text) push(synthetic ? { who: 'system', text } : { who: 'char', text })
        } else if (b.type === 'tool_use' && b.id && b.name) {
          const entry: ToolEntry = { who: 'tool', name: toolLabel(b.name), detail: describeTool(b.name, toRecord(b.input), cwd) }
          tools.set(b.id, entry)
          push(entry)
        }
      }
    } else if (m.type === 'user') {
      const text: string[] = []
      let images = 0
      for (const b of blocks(message.content)) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const entry = tools.get(b.tool_use_id)
          if (entry) {
            entry.output = toolOutput(b.content)
            entry.ok = !b.is_error
          }
        } else if (b.type === 'text' && b.text) text.push(b.text)
        else if (b.type === 'image') images++
      }
      const lines = userLines(text.join('\n'))
      if (images) {
        const note = images === 1 ? '[image]' : `[${images} images]`
        const first = lines.find((l) => l.who === 'user')
        if (first && first.who === 'user') first.text = `${first.text} ${note}`
        else lines.push({ who: 'user', text: note })
      }
      for (const l of lines) push(l)
    }
  }
  return out.slice(-HISTORY_LIMIT)
}

// ---------------------------------------------------------------- display helpers

/** Transcript titles can be raw first prompts, including the CLI's command wrapper tags. */
function cleanTitle(raw: string) {
  const command = tagged(raw, 'command-name')
  const text = command !== undefined ? `${command} ${tagged(raw, 'command-args') ?? ''}` : raw
  const clean = stripTags(text.replace(HIDDEN, ' ').replace(WRAPPER_TAGS, ' ')).replace(/\s+/g, ' ').trim()
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean
}

/** `C:\Users\me\Documents\Work\repo` → `~/Documents/Work/repo`; long paths keep their last three folders. */
export function shortPath(path: string) {
  // Windows accepts both separators, and paths arrive in either form.
  const p = path.replaceAll('\\', '/')
  const home = homedir().replaceAll('\\', '/')
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const rest = p.slice(home.length)
  const underHome = fold(p).startsWith(fold(home)) && (rest === '' || rest[0] === '/')
  const parts = (underHome ? '~' + rest : p).split(/\/+/).filter((part, i) => part || i === 0)
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-3).join('/')}` : parts.join('/')
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}
