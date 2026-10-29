import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { rank, words } from './casual/memory.ts'
import type { HistoryEntry } from './protocol.ts'
import { loadAllHistory } from './saves.ts'

// search_history: every line of this session, compacted ones included, found by word matching (BM25) over
// short overlapping stretches. Work mode has it as an in-process MCP tool, casual mode as one of her own tools,
// so after a compaction (or the compact on going back to work) nothing said earlier is out of reach.

export const HISTORY_SERVER = 'waifufy-history'
/** For `allowedTools`: reading the session's own history needs no prompt. */
export const HISTORY_TOOL_NAMES = [`mcp__${HISTORY_SERVER}__search_history`]

export const SEARCH_HISTORY_DESCRIPTION =
  'Search everything said earlier in this session, work and casual, including lines a compaction summarized away. '
  + 'Use it when the user refers to something from earlier that is not in your context.'

/** Lines per stretch, and how far the next stretch starts (so a moment split across two is still found whole). */
const CHUNK = 4
const STEP = 2
const MAX_HITS = 4
const LINE_MAX = 400
const BUDGET = 5000

type Names = { you: string; name: string }

function line(e: HistoryEntry, n: Names) {
  const clip = (s: string) => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX)}…` : s)
  if (e.who === 'tool') return `[tool] ${e.name} ${e.detail}`.trim()
  if (e.who === 'system') return undefined
  const mode = e.mode === 'casual' ? ' (casual)' : ''
  return `${e.who === 'user' ? n.you : n.name}${mode}: ${clip(e.text.replace(/\s+/g, ' ').trim())}`
}

/** The best matching stretches of `entries` for `query`, oldest first, none overlapping, within BUDGET. */
export function searchEntries(entries: HistoryEntry[], query: string, n: Names): string {
  const lines = entries.map((e) => line(e, n)).filter((l): l is string => !!l)
  const q = words(query)
  if (!q.length || !lines.length) return 'Nothing found.'
  const starts: number[] = []
  for (let i = 0; i < lines.length; i += STEP) starts.push(i)
  const chunks = starts.map((s) => lines.slice(s, s + CHUNK).join('\n'))
  const picked: number[] = []
  for (const c of rank(chunks, q)) {
    if (picked.length >= MAX_HITS) break
    if (picked.some((p) => Math.abs(starts[p] - starts[c]) < CHUNK)) continue
    picked.push(c)
  }
  if (!picked.length) return 'Nothing found.'
  let used = 0
  const out: string[] = []
  for (const c of picked.sort((a, b) => a - b)) {
    const text = `--- lines ${starts[c] + 1}–${Math.min(lines.length, starts[c] + CHUNK)} of ${lines.length}\n${chunks[c]}`
    if (used + text.length > BUDGET) continue
    out.push(text)
    used += text.length
  }
  return out.join('\n\n')
}

/** Searches session `id` as saved now. Empty until the session has a transcript. */
export async function searchHistory(id: string | undefined, cwd: string, query: string, n: Names): Promise<string> {
  if (!id) return 'Nothing said yet in this session.'
  return searchEntries(await loadAllHistory(id, cwd), query, n)
}

/** The work session's copy of the tool. `where` gives the session and names at call time. */
export function historyServer(where: () => { id?: string; cwd: string } & Names) {
  return createSdkMcpServer({
    name: HISTORY_SERVER,
    version: '1.0.0',
    tools: [
      tool('search_history', SEARCH_HISTORY_DESCRIPTION, { query: z.string().describe('Words to look for: names, topics, file names, phrases.') }, async ({ query }) => {
        const w = where()
        try {
          return { content: [{ type: 'text' as const, text: await searchHistory(w.id, w.cwd, query, w) }] }
        } catch (e) {
          return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true }
        }
      }),
    ],
  })
}
