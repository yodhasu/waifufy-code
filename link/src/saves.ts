import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { EMOTIONS, type HistoryEntry, type SessionSummary } from './protocol.ts'

// The app's own data: which sessions it started, and settings.
const DIR = join(process.env.APPDATA ?? homedir(), 'waifufy-code')
const SESSIONS = join(DIR, 'sessions.json')
const SETTINGS = join(DIR, 'settings.json')

type Entry = { id: string; cwd: string; createdAt: number }
export type Settings = { userName: string }
const DEFAULT_SETTINGS: Settings = { userName: 'Yodha' }

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await readJson<Partial<Settings>>(SETTINGS, {})) }
}

/** Only sessions started here are listed: a terminal session would resume without Rem's persona. */
export async function rememberSession(id: string, cwd: string) {
  const entries = await readJson<Entry[]>(SESSIONS, [])
  if (entries.some((e) => e.id === id)) return
  entries.push({ id, cwd, createdAt: Date.now() })
  await mkdir(DIR, { recursive: true })
  await writeFile(SESSIONS, JSON.stringify(entries, null, 2) + '\n')
}

export async function listSessions(): Promise<SessionSummary[]> {
  const entries = await readJson<Entry[]>(SESSIONS, [])
  const found = await Promise.all(
    entries.map(async (e) => {
      const info = await getSessionInfo(e.id, { dir: e.cwd }).catch(() => undefined)
      if (!info) return undefined
      const cwd = info.cwd ?? e.cwd
      const summary: SessionSummary = {
        id: e.id,
        title: info.customTitle || info.summary || info.firstPrompt || 'Untitled',
        cwd,
        cwdShort: shortPath(cwd),
        branch: info.gitBranch,
        lastModified: info.lastModified,
      }
      return summary
    }),
  )
  return found.filter((s) => s !== undefined).sort((a, b) => b.lastModified - a.lastModified)
}

const TAGS = new RegExp(`\\[(?:${EMOTIONS.join('|')})\\]\\s*`, 'g')
const HISTORY_LIMIT = 120

/** The conversation so far, as plain lines for the backlog. Tool traffic is left out. */
export async function loadHistory(id: string, cwd: string): Promise<HistoryEntry[]> {
  const messages = await getSessionMessages(id, { dir: cwd }).catch(() => [])
  const history: HistoryEntry[] = []
  for (const m of messages) {
    if (m.parent_tool_use_id || (m.type !== 'user' && m.type !== 'assistant')) continue
    const content = (m.message as { content?: unknown })?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((b) => b?.type === 'text').map((b) => b.text as string).join('\n')
          : ''
    // Skip harness-injected user text (command output, reminders).
    if (!text.trim() || (m.type === 'user' && text.trimStart().startsWith('<'))) continue
    history.push({ who: m.type === 'user' ? 'user' : 'rem', text: m.type === 'assistant' ? text.replace(TAGS, '') : text })
  }
  return history.slice(-HISTORY_LIMIT)
}

/** `C:\Users\me\Documents\Work\repo` → `~/Documents/Work/repo`; long paths keep their last three folders. */
export function shortPath(path: string) {
  const home = homedir()
  let p = path.toLowerCase().startsWith(home.toLowerCase()) ? '~' + path.slice(home.length) : path
  p = p.split(sep).join('/')
  const parts = p.split('/')
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-3).join('/')}` : p
}
