// Messages between the app (WebSocket client) and the link (Agent SDK sidecar).
// This file is the only contract between the two halves; the app imports it for types only.
// See docs/V1.md for the requirements each message serves.

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
  /** 0 – 5 hearts. */
  affection: number
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
}

export type Todo = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }

export type Question = {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string; preview?: string }[]
}

export type Command = { name: string; description: string; argumentHint: string; builtin: boolean }
export type ModelChoice = { value: string; displayName: string; description: string; resolved?: string }

export type FileHit = { path: string; isDir: boolean }

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
  | { t: 'save_meta'; id: string; patch: Partial<Pick<Save, 'playMs' | 'turns' | 'affection' | 'costume' | 'lastLine'>>; thumb?: string }
  | { t: 'costumes'; dir?: string }
  /** `epoch` is chosen by the app; every session event carries it back, so stale events can be dropped. */
  | { t: 'start'; epoch: number; cwd: string; resume?: string }
  | { t: 'say'; text: string; images?: Image[] }
  /** `!cmd`: runs in the session folder; output is appended to context without starting a turn. */
  | { t: 'shell'; command: string }
  | { t: 'files'; query: string }
  | { t: 'interrupt' }
  | { t: 'end' }
  | { t: 'mode'; mode: PermissionModeName }
  | { t: 'model'; model: string }
  /** 'deny' stops the turn (CLI "No"); 'feedback' denies with `message` and lets the character continue. */
  | { t: 'permission'; id: string; decision: 'allow' | 'always' | 'deny' | 'feedback'; message?: string }
  | { t: 'answer'; id: string; answers: Record<string, string> }
  /** Plan approval. 'auto' approves and switches to acceptEdits; 'manual' approves in default mode. */
  | { t: 'plan'; id: string; decision: 'auto' | 'manual' | 'keep'; message?: string }
  /** Builds the persona prompt for `settings` without saving them (settings preview, R39). */
  | { t: 'persona_preview'; settings: Settings }
  | { t: 'research'; name: string; series: string; notes: string }
  | { t: 'research_cancel' }
  /** Opens a folder or file in the OS (Explorer). */
  | { t: 'reveal'; path: string }

// ---------------------------------------------------------------- link → client

/** Events of a running session. Each carries the `epoch` from its `start`. */
export type SessionEvent =
  | { t: 'started'; cwd: string; cwdShort: string; resumed: boolean; history: HistoryEntry[]; save?: Save }
  /** Sent as soon as the CLI handshake completes (before the first turn). */
  | { t: 'ready'; sessionId?: string; commands: Command[]; models: ModelChoice[]; mode: PermissionModeName; model?: string; account?: string }
  | { t: 'session_id'; sessionId: string }
  | { t: 'commands'; commands: Command[] }
  | { t: 'face'; emotion: Emotion }
  | { t: 'text'; delta: string }
  | { t: 'text_end' }
  /** Streaming progress for the spinner. */
  | { t: 'progress'; outputTokens: number; phase: 'thinking' | 'writing' | 'tool' | 'compacting' | 'retrying'; note?: string }
  /** `input` is pretty JSON, truncated. `sub`: from a subagent. */
  | { t: 'tool'; id: string; name: string; detail: string; input: string; sub: boolean }
  | { t: 'tool_done'; id: string; ok: boolean; output: string }
  | { t: 'todos'; items: Todo[] }
  | { t: 'agent'; id: string; description: string; status: 'running' | 'done' | 'failed' }
  | { t: 'ask_permission'; id: string; tool: string; title: string; detail: string; diffs: Diff[]; canAlways: boolean; danger: boolean; defaultToNo: boolean; reason?: string }
  | { t: 'ask_question'; id: string; questions: Question[] }
  | { t: 'ask_plan'; id: string; plan: string; planFile?: string }
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

export type ServerMsg =
  | { t: 'hello'; version: string; settings: Settings; auth: Auth; dataDir: string }
  | { t: 'settings'; settings: Settings }
  | { t: 'auth'; auth: Auth }
  | { t: 'saves'; list: Save[] }
  | { t: 'costumes'; list: Costume[]; dir: string; found: boolean }
  | { t: 'files'; query: string; hits: FileHit[] }
  | { t: 'persona_preview'; text: string }
  | { t: 'research_progress'; text: string }
  | { t: 'research_done'; preset: PersonaPreset }
  | { t: 'research_error'; message: string }
  | (SessionEvent & { epoch: number })
  /** Errors not tied to a session (bad request, settings write failed). */
  | { t: 'app_error'; message: string }
