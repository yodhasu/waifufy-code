// Messages between the app (WebSocket client) and the link (Agent SDK sidecar).
// The app imports this file for types only.

/** Emotion tags Rem puts in her replies, like `[smile]`. Each one maps to a Live2D pose in the app. */
export const EMOTIONS = [
  'normal', 'smile', 'happy', 'delighted', 'nod', 'think', 'worried', 'serious',
  'surprised', 'shy', 'pout', 'sad', 'angry', 'sigh', 'teary',
] as const
export type Emotion = (typeof EMOTIONS)[number]

export type PermissionModeName = 'default' | 'acceptEdits' | 'plan'

export type SessionSummary = {
  id: string
  title: string
  cwd: string
  /** `cwd` shortened for display, like `~/Work/booking-tools`. */
  cwdShort: string
  branch?: string
  lastModified: number
}

export type HistoryEntry = { who: 'rem' | 'user'; text: string }

export type Limit = { pct: number; resetsAt?: number }

export type Stats = {
  costUsd: number
  turns: number
  apiMs: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  /** `parts` are the used rows of getContextUsage(), by category id. */
  context?: { used: number; max: number; parts: { id: string; tokens: number }[] }
  limits: { fiveHour?: Limit; weekly?: Limit }
  model?: string
  mode?: string
}

export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export type Question = {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

export type Command = { name: string; description: string; argumentHint: string; builtin: boolean }

export type ClientMsg =
  | { t: 'sessions' }
  | { t: 'start'; cwd: string; resume?: string }
  | { t: 'say'; text: string }
  | { t: 'interrupt' }
  | { t: 'end' }
  | { t: 'mode'; mode: PermissionModeName }
  | { t: 'model'; model: string }
  | { t: 'permission'; id: string; decision: 'allow' | 'always' | 'deny'; message?: string }
  | { t: 'answer'; id: string; answers: Record<string, string> }

export type ServerMsg =
  | { t: 'sessions'; list: SessionSummary[] }
  | { t: 'started'; cwd: string; cwdShort: string; userName: string; history: HistoryEntry[] }
  | { t: 'init'; sessionId: string; commands: Command[]; models: { value: string; displayName: string }[] }
  | { t: 'face'; emotion: Emotion }
  | { t: 'text'; delta: string }
  | { t: 'text_end' }
  /** `sub`: the call came from a subagent. */
  | { t: 'tool'; id: string; name: string; detail: string; sub: boolean }
  | { t: 'tool_done'; id: string; ok: boolean }
  | { t: 'todos'; items: Todo[] }
  | { t: 'ask_permission'; id: string; tool: string; detail: string; canAlways: boolean; danger: boolean }
  | { t: 'ask_question'; id: string; questions: Question[] }
  | { t: 'ask_plan'; id: string; plan: string }
  | { t: 'ask_cancel'; id: string }
  | { t: 'state'; state: 'idle' | 'running' | 'requires_action' }
  | { t: 'stats'; stats: Stats }
  | { t: 'turn_end'; ok: boolean; error?: string; seconds: number }
  | { t: 'error'; message: string }
  | { t: 'ended' }
