// Messages between the app (WebSocket client) and the link (Agent SDK sidecar).
// This file is the only contract between the two halves; the app imports it for types only.
// See docs/V1.md for the requirements each message serves.

import type { Mood } from './affection.ts'

/** Emotion tags the character writes inline, like `text [smile] text`. Each maps to a Live2D gesture + hold. */
export const EMOTIONS = [
  'normal', 'smile', 'happy', 'delighted', 'nod', 'think', 'worried', 'serious',
  'surprised', 'shy', 'pout', 'sad', 'angry', 'sigh', 'teary',
] as const
export type Emotion = (typeof EMOTIONS)[number]

export type PermissionModeName = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

// ---------------------------------------------------------------- settings

export type Honorific = 'kun' | 'sama' | 'chan' | 'san' | 'senpai' | 'dono' | 'none' | 'custom'
export type Relationship = 'maid' | 'childhood' | 'senpai' | 'kouhai' | 'partner' | 'rival' | 'custom'
/** How in-character work output (reports, explanations) is. */
export type WorkVoice = 'full' | 'balanced' | 'work'
export type Expressiveness = 'low' | 'normal' | 'high'

export type Profile = {
  displayName: string
  /** What she calls you, before the honorific: "Yodha" → "Yodha-kun". */
  callMe: string
  honorific: Honorific
  customHonorific: string
  pronouns: string
  title: string
  /** Free text she should know about you. */
  about: string
  /** data: URL of the avatar image, or '' for none. */
  avatar: string
  /** Nameplate color, a CSS color. */
  nameColor: string
}

export type Waifu = {
  name: string
  series: string
  relationship: Relationship
  relationshipCustom: string
  /** A preset id from the app's personality presets, or 'custom'. */
  personalityPreset: string
  personality: string
  /** 0 (casual) – 100 (very formal). */
  formality: number
  /** 0 (serious) – 100 (very playful). */
  playfulness: number
  /** 0 (terse) – 100 (chatty). Work content stays complete either way. */
  verbosity: number
  catchphrases: string[]
  japanese: boolean
  kaomoji: boolean
  workVoice: WorkVoice
  expressiveness: Expressiveness
  customInstructions: string
  /** Id of the applied research preset, or '' when the persona is hand-written. */
  activePreset: string
}

export type ResearchProfile = {
  summary: string
  personality: string[]
  speechPatterns: string[]
  catchphrases: string[]
  /** How the character addresses others, e.g. honorifics, nicknames. */
  addressing: string
  relationshipCues: string[]
  do: string[]
  dont: string[]
  sampleLines: string[]
}

export type PersonaPreset = {
  id: string
  name: string
  series: string
  notes: string
  createdAt: number
  profile: ResearchProfile
  /** The tailored roleplay prompt, editable by the user. Used verbatim in the persona when active. */
  prompt: string
  sources: string[]
}

export type Appearance = {
  theme: 'light' | 'dark' | 'system'
  /** CSS color for the accent token. */
  accent: string
  /** Dialogue font size in stage pixels. */
  fontSize: number
  /** Dialogue box opacity, 0.5 – 1. */
  boxOpacity: number
  background: 'day' | 'night' | 'auto'
  petals: boolean
  /** Costume id (model folder name), e.g. 'ac_base_rem01'. */
  costume: string
  /** Sprite zoom multiplier, 0.8 – 1.6. */
  zoom: number
  /** Folder containing costume model folders (each with a .model3.json). */
  modelsDir: string
}

export type MotionSettings = {
  /** Typewriter characters per second; 0 = instant. Default 14 (speech pace, ~150 wpm). */
  textCps: number
  punctuationPauses: boolean
  /** Extra delay before AUTO advances, in ms. */
  autoDelayMs: number
  lipSync: boolean
  idle: boolean
  cursor: boolean
  headpats: boolean
  taps: boolean
  gestures: boolean
}

export type ClaudeSettings = {
  /** Model alias/id for new sessions; '' = the CLI default. */
  model: string
  permissionMode: PermissionModeName
  /** Folder New Game opens first; '' = last used. */
  defaultDir: string
  settingSources: ('user' | 'project' | 'local')[]
}

export type Settings = {
  version: 1
  onboarded: boolean
  profile: Profile
  waifu: Waifu
  presets: PersonaPreset[]
  appearance: Appearance
  motion: MotionSettings
  claude: ClaudeSettings
  voice: { provider: 'off' }
  /** Last folder a session was started in. */
  lastDir: string
}

// ---------------------------------------------------------------- saves, costumes, files

export type Save = {
  id: string
  title: string
  cwd: string
  /** `cwd` shortened for display, like `~/Work/booking-tools`. */
  cwdShort: string
  branch?: string
  createdAt: number
  lastModified: number
  /** Time spent in the session in the app, ms. */
  playMs: number
  turns: number
  /** 0 – 5 hearts (the level of affectionPts). */
  affection: number
  /** Affection points (affection.ts); absent in saves from before points, read from the hearts then. */
  affectionPts?: number
  costume?: string
  /** URL path of the thumbnail on the link server, with a cache-busting query; absent when none. */
  thumb?: string
  /** Last line the character said, tags stripped. */
  lastLine?: string
}

export type Costume = {
  /** Model folder name, e.g. 'ac_base_rem_xmas01'. */
  id: string
  /** Human label, e.g. 'Christmas'. */
  label: string
  /** URL path of the .model3.json on the link server. */
  modelUrl: string
}

export type HistoryEntry =
  | { who: 'char' | 'user'; text: string }
  | { who: 'tool'; name: string; detail: string; output?: string; ok?: boolean }
  | { who: 'system'; text: string }

export type Limit = { pct: number; resetsAt?: number; status?: 'allowed' | 'allowed_warning' | 'rejected' }

export type Stats = {
  costUsd: number
  /** Completed turns (results), cumulative across resume. */
  turns: number
  apiMs: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  linesAdded?: number
  linesRemoved?: number
  /** `parts` are getContextUsage() rows by category id with kind used|buffer. */
  context?: { used: number; max: number; parts: { id: string; tokens: number; kind: string }[] }
  limits: { fiveHour?: Limit; weekly?: Limit; weeklyOpus?: Limit }
  /** Model id as the CLI reports it (resolved). */
  model?: string
  mode?: PermissionModeName
  /** The effort level in use ("high"), as the CLI's /effort reports it: the spinner's "thinking with high effort". */
  effort?: string
}

export type Todo = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }

export type Question = {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string; preview?: string }[]
}

/** `aliases`: other names that run it, as the CLI resolves them (`/cost` and `/stats` run `/usage`). */
export type Command = { name: string; description: string; argumentHint: string; builtin: boolean; aliases?: string[] }
/** `supportsAuto`: the model offers auto mode, so Shift+Tab includes it (R13). */
export type ModelChoice = { value: string; displayName: string; description: string; resolved?: string; supportsAuto?: boolean }

/** An @-mention hit: a file or folder, or (`agent`) a subagent the CLI mentions as `@agent-<name>`. */
export type FileHit = { path: string; isDir: boolean; agent?: { name: string; description: string } }

export type Diff = { path: string; before: string; after: string }

export type Auth = { loggedIn: boolean; email?: string; subscription?: string; method?: string; error?: string }

export type Image = { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }

// ---------------------------------------------------------------- client → link

export type ClientMsg =
  | { t: 'hello' }
  | { t: 'settings_set'; settings: Settings }
  | { t: 'auth_check' }
  /** Opens the bundled Claude Code login in a console window. */
  | { t: 'login' }
  | { t: 'saves' }
  | { t: 'save_rename'; id: string; title: string }
  | { t: 'save_delete'; id: string }
  /** Updates play stats / thumbnail of the running save. `thumb` is a data: URL (JPEG). */
  | { t: 'save_meta'; id: string; patch: Partial<Pick<Save, 'playMs' | 'turns' | 'affection' | 'affectionPts' | 'costume' | 'lastLine'>>; thumb?: string }
  | { t: 'costumes'; dir?: string }
  /** Whether `cwd` is trusted for its project settings, as the terminal's trust dialog decides; answered with `trust`. */
  | { t: 'trust_check'; cwd: string }
  /** The user accepted the trust dialog for `cwd`; answered with `trust`. */
  | { t: 'trust_accept'; cwd: string }
  /** `epoch` is chosen by the app; every session event carries it back, so stale events can be dropped. Refused for an untrusted `cwd`. */
  /**
   * `resumeAt` (with `resume`): rewind the conversation, keeping the transcript up to and including that entry.
   * `dropsTurn`: the prompt whose turn the rewind discards, so the CLI can check nothing else is lost.
   */
  | { t: 'start'; epoch: number; cwd: string; resume?: string; resumeAt?: string; dropsTurn?: string }
  /** `now`: Ctrl+Enter, the CLI's "send now": delivered to the running turn at once instead of after it. */
  | { t: 'say'; text: string; images?: Image[]; now?: boolean; mood?: Mood }
  /** `!cmd`: runs in the session folder; output is appended to context without starting a turn. */
  | { t: 'shell'; command: string }
  | { t: 'files'; query: string }
  | { t: 'interrupt' }
  | { t: 'end' }
  | { t: 'mode'; mode: PermissionModeName }
  | { t: 'model'; model: string }
  /** 'deny' stops the turn (CLI "No"); 'feedback' denies with `message` and lets the character continue. */
  | { t: 'permission'; id: string; decision: 'allow' | 'always' | 'deny' | 'feedback'; message?: string; option?: string }
  | { t: 'answer'; id: string; answers: Record<string, string> }
  /** Plan approval. 'auto' approves and switches to acceptEdits; 'manual' approves in default mode. */
  | { t: 'plan'; id: string; decision: 'auto' | 'manual' | 'keep'; message?: string }
  /** Builds the persona prompt for `settings` without saving them (settings preview, R39). */
  | { t: 'persona_preview'; settings: Settings }
  | { t: 'research'; name: string; series: string; notes: string }
  | { t: 'research_cancel' }
  /** Opens a folder or file in the OS (Explorer). */
  | { t: 'reveal'; path: string }
  /** Opens an http(s) URL in the browser, or a file with its default app (an MCP sign-in page, CLAUDE.md). */
  | { t: 'open'; target: string }
  /** The answer to an `ask_elicit`: accept with the form's `content`, decline, or cancel. */
  | { t: 'elicit'; id: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, ElicitValue> }
  /** Calls one of the running session's SDK controls (CTL_OPS) with positional `args`; answered with `ctl_result`. */
  | { t: 'ctl'; id: string; op: CtlOp; args?: unknown[] }

/**
 * The running session's SDK controls the app may call directly: `Query` methods, by name. They back the in-app
 * versions of the CLI's interactive panels (/mcp, /agents, /context, /usage, /status, /effort, /rewind, /tasks).
 * `usage` is the SDK's experimental data call behind `/usage`. `mcpLogin` and `mcpLogout` have no SDK control: the link
 * runs `claude mcp login|logout <name>` for them. `cli` runs a slash command such as
 * `/config key=value` silently and answers with its text output. `settingsFiles`, `editSettings`, `cliExec` and
 * `readText` / `createText` are link-side file and CLI helpers (link/src/config-files.ts) for the panels the SDK has no control for.
 */
export const CTL_OPS = [
  'mcpServerStatus', 'reconnectMcpServer', 'toggleMcpServer', 'setMcpPermissionModeOverride', 'readMcpResource',
  'supportedAgents', 'supportedCommands', 'supportedModels', 'initializationResult', 'accountInfo',
  'getContextUsage', 'usage', 'reloadPlugins', 'reloadSkills', 'reloadOutputStyles',
  'applyFlagSettings', 'updateSettings', 'setMaxThinkingTokens', 'rewindFiles', 'stopTask',
  'mcpLogin', 'mcpLogout', 'cli', 'rewindPoints', 'backgroundTasks', 'settingsFiles', 'editSettings', 'cliExec', 'readText', 'createText', 'gitDiff',
] as const

export type CtlOp = (typeof CTL_OPS)[number]

// ---------------------------------------------------------------- link → client

/** Events of a running session. Each carries the `epoch` from its `start`. */
export type SessionEvent =
  | { t: 'started'; cwd: string; cwdShort: string; resumed: boolean; history: HistoryEntry[]; save?: Save }
  /** Sent as soon as the CLI handshake completes (before the first turn). */
  /** `bypassAvailable`: the session was started with bypass permissions, so Shift+Tab may cycle to it, as in the CLI. */
  | { t: 'ready'; sessionId?: string; commands: Command[]; models: ModelChoice[]; mode: PermissionModeName; model?: string; account?: string; bypassAvailable?: boolean }
  | { t: 'session_id'; sessionId: string }
  | { t: 'commands'; commands: Command[] }
  | { t: 'face'; emotion: Emotion }
  /** She took the user's message as kind (+1) or unkind (-1): at most once per turn. */
  | { t: 'affection'; delta: 1 | -1 }
  | { t: 'text'; delta: string }
  | { t: 'text_end' }
  /** Streaming progress for the spinner. */
  | { t: 'progress'; outputTokens: number; phase: 'thinking' | 'writing' | 'tool' | 'compacting' | 'retrying'; note?: string }
  /** `input` is pretty JSON, truncated. `sub`: from a subagent. */
  | { t: 'tool'; id: string; name: string; detail: string; input: string; sub: boolean }
  | { t: 'tool_done'; id: string; ok: boolean; output: string }
  | { t: 'todos'; items: Todo[] }
  | { t: 'agent'; id: string; description: string; status: 'running' | 'done' | 'failed' }
  /**
   * `input`: the call's full parameters (pretty JSON, clipped) for tools without a diff or command, so nothing is
   * approved unseen. `always`: what "don't ask again" saves, like the CLI's label ("npm run test:* commands in …").
   */
  | { t: 'ask_permission'; id: string; tool: string; title: string; detail: string; diffs: Diff[]; canAlways: boolean; danger: boolean; defaultToNo: boolean; reason?: string; input?: string; always?: string; question?: string; choices?: PermChoice[] }
  | { t: 'ask_question'; id: string; questions: Question[] }
  | { t: 'ask_plan'; id: string; plan: string; planFile?: string }
  /**
   * An MCP server asks the user for input (elicitation): a form built from its JSON schema, or a URL to open
   * (a sign-in). Answered with `elicit`; `ask_cancel` closes it when the server stops waiting.
   */
  | { t: 'ask_elicit'; id: string; server: string; mode: 'form' | 'url'; message: string; title?: string; url?: string; fields: ElicitField[] }
  | { t: 'ask_cancel'; id: string }
  | { t: 'state'; state: 'idle' | 'running' | 'requires_action' }
  | { t: 'stats'; stats: Stats }
  /** Output of a local slash command or a system notice (compaction, retries). */
  | { t: 'notice'; text: string; kind: 'command' | 'compact' | 'retry' | 'info' }
  | { t: 'shell_result'; command: string; output: string; code: number | null }
  /** `interrupted`: the user stopped it (not an error). */
  | { t: 'turn_end'; ok: boolean; interrupted: boolean; error?: string; seconds: number }
  | { t: 'error'; message: string; kind: 'auth' | 'api' | 'process' | 'internal' }
  | { t: 'ended'; reason: 'closed' | 'crashed' }
  /** A CLI notification (an MCP server needs auth, a plugin update, a context warning…), by priority. */
  | { t: 'notify'; key: string; text: string; priority: 'low' | 'medium' | 'high' | 'immediate' }
  /** Every background task the CLI tracks (agents, shells, monitors), whole: the /tasks panel and Ctrl+B. */
  | { t: 'bg_tasks'; tasks: BgTask[] }
  /** The CLI's greyed next-prompt suggestion, after a turn. */
  | { t: 'suggestion'; text: string }
  /** A hook running (PreToolUse, Stop…): the spinner names it; a failure is logged. */
  | { t: 'hook'; id: string; name: string; event: string; state: 'running' | 'ok' | 'error' | 'cancelled'; output?: string }

export type ServerMsg =
  | { t: 'hello'; version: string; settings: Settings; auth: Auth; dataDir: string }
  | { t: 'settings'; settings: Settings }
  | { t: 'auth'; auth: Auth }
  | { t: 'saves'; list: Save[] }
  | { t: 'costumes'; list: Costume[]; dir: string; found: boolean }
  | { t: 'files'; query: string; hits: FileHit[] }
  /** `concerns`: what the folder's own settings would apply without asking (hooks, MCP servers, pre-approved rules). */
  | { t: 'trust'; cwd: string; trusted: boolean; concerns: string[] }
  | { t: 'persona_preview'; text: string }
  | { t: 'research_progress'; text: string }
  | { t: 'research_done'; preset: PersonaPreset }
  | { t: 'research_error'; message: string }
  | (SessionEvent & { epoch: number })
  /** Errors not tied to a session (bad request, settings write failed). */
  | { t: 'app_error'; message: string }
  /** The answer to a `ctl`: the SDK call's result, or its error message. */
  | { t: 'ctl_result'; id: string; ok: boolean; data?: unknown; error?: string }

/** One input of an MCP elicitation form, from a property of its requested JSON schema. */
export type ElicitField = {
  name: string
  title: string
  description?: string
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'multi'
  required: boolean
  /** For choice and multi: the allowed values, with display labels when the schema has them. */
  options?: { value: string; label: string }[]
  default?: ElicitValue
  /** For text: email, uri, date or date-time. */
  format?: string
  min?: number
  max?: number
}

export type ElicitValue = string | number | boolean | string[]

/**
 * One row of a permission prompt, worded as the CLI words it ("Yes, and don't ask again for npm run commands in
 * ~/app"). The app answers with its `decision` and `id` (as `option`). `mode`: the row switches the session's
 * permission mode, which Shift+Tab picks in the CLI.
 */
export type PermChoice = { id: string; label: string; decision: 'allow' | 'always' | 'deny' | 'feedback'; mode?: boolean }

/** A background task, as the CLI's Background panel lists it. `toolUseId`: the Bash or Agent call that started it. */
export type BgTask = {
  id: string
  type: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'
  subagent?: string
  toolUseId?: string
  summary?: string
  lastTool?: string
  tokens?: number
  toolUses?: number
  ms?: number
  error?: string
}

/** A user prompt the conversation can be rewound to (Esc Esc / /rewind). `before`: the last entry it keeps. */
export type RewindPoint = { uuid: string; text: string; before?: string }
