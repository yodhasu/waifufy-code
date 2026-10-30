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
  /** How she speaks aloud in `language`, and how the voice should say her name and words, from the research. */
  voice?: { language: 'ja' | 'en'; styleNotes: string; pronunciations: string }
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
  /** Which rig she is drawn with. 'mmd' (a 3D .pmx) is stored on the card ahead of its renderer; until then the app shows Live2D. */
  model: ModelKind
  /** Absolute path of her .pmx when `model` is 'mmd'; '' otherwise. Never leaves this machine. */
  mmdFile: string
}

export const MODEL_KINDS = ['live2d', 'mmd'] as const
export type ModelKind = (typeof MODEL_KINDS)[number]

/** Fish Audio models: the free developer tier, or the paid one with an SLA. */
export const VOICE_MODELS = ['s2.1-pro-free', 's2.1-pro'] as const
export type VoiceModel = (typeof VOICE_MODELS)[number]

/** Her voice (docs/research/rem-voice.md). Plays only while a Fish Audio key is stored (`hello.voiceKey`). */
export type VoiceSettings = {
  /** On by default; with no key there is nothing to play, so it acts as off. */
  enabled: boolean
  /** Fish Audio voice model id (`reference_id`). */
  voiceId: string
  model: VoiceModel
  /** 'ja': the text stays English and she speaks a Japanese line per paragraph; 'en': she reads the text. */
  language: 'ja' | 'en'
  /** 0.5–2 (Fish prosody.speed). */
  speed: number
  /** 0–100. */
  volume: number
  /** Show the Japanese line under the English one while she speaks it. */
  subtitles: boolean
  /** How she speaks in `language`: register, self-reference, endings (the default is Rem's Japanese). */
  styleNotes: string
  /**
   * How the voice should say words it gets wrong, one per line: `Reine = Ray-neh`. Only the voice uses them; the
   * text keeps the real spelling.
   */
  pronunciations: string
}

/** Slack (link/src/slack.ts). The tokens live in the link's own file, never here. */
export type SlackSettings = {
  /** Client ID of the workspace's own Slack app (link/src/slack-app.ts); '' until set up. Not a secret. */
  clientId: string
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

/** Work: Claude Code, as always. Casual: her own chat harness (link/src/casual), on the same history. */
export type ChatMode = 'work' | 'casual'

/** Casual mode (v0.7). The API key lives in the link's own file (`casual_key`), never here. */
export type CasualSettings = {
  /** 'openai': any OpenAI-compatible chat API, while a key is stored. Without one, and for 'claude', Claude answers through the Agent SDK. */
  provider: 'openai' | 'claude'
  baseUrl: string
  model: string
  /** Sent as `reasoning_effort` when not ''. */
  reasoningEffort: string
  /** Claude model (alias or id) when Claude answers in casual mode. */
  claudeModel: string
  /** Model her toolkit (Claude Code with your tools and MCP servers) runs on when she uses it. */
  toolModel: string
  /** This session's work lines are in her casual history (and so reach the casual model). */
  shareWork: boolean
  /** Reflect, judge and tune after a quiet spell in casual mode. */
  learning: boolean
  /** Minutes casual mode is quiet before she reflects. */
  idleMin: number
  /** 0 – 10: below this judge score, her style gets a revision (kept only if it replays better). */
  judgeThreshold: number
  /** Who reflects and judges: Claude, or the casual model itself. */
  learnWith: 'claude' | 'casual'
  /** Back from casual to work: ask each time, or always compact (work starts from a summary) or keep the full context. */
  toWork: 'ask' | 'compact' | 'keep'
  /** She may message first in casual mode (initiative.ts): when, and whether, is up to her personality. */
  initiative: boolean
  /** Rules in the user's own words that her own messages never break ("nothing after 23:00"). */
  boundaries: string
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
  voice: VoiceSettings
  slack: SlackSettings
  casual: CasualSettings
  /** Id of the active waifu card (link/src/cards.ts). The waifu, presets, model and voice fields above are its live copy. */
  card: string
  /** Last folder a session was started in. */
  lastDir: string
}

// ---------------------------------------------------------------- waifu cards

/**
 * Everything that makes her *her*, bundled so the user can swap characters: persona, research presets, the rig she
 * is drawn with, her voice, and the love meter. What she learned about the user (casual memory, her mood) is the
 * user's personal save: it stays in the data folder under the card's id and never goes into a card file.
 */
export type WaifuCard = {
  version: 1
  id: string
  waifu: Waifu
  /** The preset she plays (waifu.activePreset), if any; the library itself is shared by every card. */
  presets: PersonaPreset[]
  look: Pick<Appearance, 'model' | 'modelsDir' | 'costume' | 'zoom' | 'mmdFile'>
  voice: Pick<VoiceSettings, 'voiceId' | 'language' | 'speed' | 'styleNotes' | 'pronunciations'>
  /** The love meter: affection points (affection.ts), carried from session to session with the card. */
  love: { points: number }
  createdAt: number
  updatedAt: number
}

/** A card as the picker lists it. */
export type CardSummary = {
  id: string
  name: string
  series: string
  model: ModelKind
  costume: string
  /** 0 – 5 hearts. */
  hearts: number
  points: number
  voiced: boolean
  updatedAt: number
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
  /** The waifu card the save was played with; absent in saves from before cards (the first card then). */
  card?: string
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
  | { who: 'char' | 'user'; text: string; mode?: 'casual' }
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

// ---------------------------------------------------------------- slack

/** Whether the link is signed in to Slack, and as whom. */
export type SlackStatus = {
  signedIn: boolean
  /** A sign-in is waiting on the browser. */
  signingIn: boolean
  team?: string
  user?: string
  /** The workspace's web address, like https://covena.slack.com/. */
  url?: string
  /** Why the last sign-in failed, or why the link was signed out (a revoked token). */
  error?: string
}

export type SlackConvKind = 'dm' | 'group' | 'channel' | 'private'

/** A conversation the signed-in person is in. `unread`: counted up to `UNREAD_PEEK`, with `more` past it. */
export type SlackConv = {
  id: string
  /** `#general`, a person's name for a DM, the members for a group DM. */
  name: string
  kind: SlackConvKind
  unread: number
  more: boolean
  /** An unread message mentions the person. */
  mention: boolean
  /** The newest unread message, one line. */
  preview?: { user: string; text: string; ts: string }
}

/**
 * The unread inbox, rebuilt as the link scans every conversation in turn (Slack has no public unread-count call
 * for channels). `convs` holds only conversations with unread messages, DMs first, newest first.
 */
export type SlackInbox = { convs: SlackConv[]; scanned: number; total: number; updatedAt: number }

export type SlackMessage = {
  ts: string
  user: string
  /** Plain text: mentions, channels and links already turned into names. */
  text: string
  mine: boolean
  /** Replies in its thread (on the parent message only). */
  replies?: number
  /** Names of attached files. */
  files?: string[]
}

// ---------------------------------------------------------------- phone access

/** Phone access (link/src/remote.ts), as the desktop's Settings → Phone shows it. Only desktop windows get it. */
export type RemoteStatus = {
  enabled: boolean
  /** The phone listener is up (it can fail: the port taken). */
  listening: boolean
  port: number
  /** This computer's addresses a phone can try, best first. */
  addresses: string[]
  /** Phones connected right now. */
  clients: number
  /** Phones paired with this computer, each with its own token (never sent here), seen most recently first. */
  devices: { id: string; name: string; pairedAt: number; lastSeen: number; online: boolean }[]
  /** What the pairing QR code holds (with the token); only while enabled. */
  pairUrl?: string
  error?: string
}

// ---------------------------------------------------------------- client → link

export type ClientMsg =
  | { t: 'hello' }
  /** Something the page wants in link.log (a 3D model that failed on a phone, say): the only way to read a phone's errors. */
  | { t: 'client_log'; text: string }
  /** Synthesizes one voice line; answered by a `tts` with the same id. */
  | { t: 'tts'; id: string; text: string }
  /** Stores the Fish Audio API key in the link (never in settings); an empty key removes it. */
  | { t: 'voice_key'; key: string }
  | { t: 'settings_set'; settings: Settings }
  | { t: 'auth_check' }
  /** Opens the bundled Claude Code login in a console window. */
  | { t: 'login' }
  | { t: 'saves' }
  /** The card list; answered by `cards`. */
  | { t: 'cards' }
  /** Makes `id` the active card: its persona, model and voice from the next session. Answered by `settings` and `cards`. */
  | { t: 'card_switch'; id: string }
  /** A new card, made active: a copy of `from` (a card id), or the default character when absent. */
  | { t: 'card_new'; from?: string }
  /** Deletes a card that isn't active. Its personal save (memory, mood) stays in the data folder. */
  | { t: 'card_delete'; id: string }
  /** Writes the card to `path` as a .waifu.json file, without any personal save. Answered by `card_file`. */
  | { t: 'card_export'; id: string; path: string }
  /** Reads a .waifu.json file into a new card (not made active). Answered by `card_file` and `cards`. */
  | { t: 'card_import'; path: string }
  | { t: 'save_rename'; id: string; title: string }
  | { t: 'save_delete'; id: string }
  /** Updates play stats / thumbnail of the running save. `thumb` is a data: URL (JPEG). */
  | { t: 'save_meta'; id: string; patch: Partial<Pick<Save, 'playMs' | 'turns' | 'affection' | 'affectionPts' | 'costume' | 'lastLine'>>; thumb?: string }
  | { t: 'costumes'; dir?: string }
  /** Whether `cwd` is trusted for its project settings, as the terminal's trust dialog decides; answered with `trust`. */
  | { t: 'trust_check'; cwd: string }
  /** The user accepted the trust dialog for `cwd`; answered with `trust`. */
  | { t: 'trust_accept'; cwd: string }
  /** A file to attach to the next message, any kind, as base64; answered with `file_put` and the path to mention. */
  | { t: 'file_put'; id: string; name: string; data: string }
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
   * Starts the Slack sign-in in the browser with the workspace app's `clientId` (sent along, since the settings
   * save is debounced); `slack_status` follows its progress.
   */
  | { t: 'slack_signin'; clientId: string }
  | { t: 'slack_signin_cancel' }
  | { t: 'slack_signout' }
  /** Answered with `slack_status` and `slack_inbox`; `refresh` also starts a rescan of every conversation. */
  | { t: 'slack_inbox'; refresh?: boolean }
  /** Every conversation the person is in (to read one with nothing unread); answered with `slack_convs`. */
  | { t: 'slack_convs' }
  /** A conversation's latest messages, or a thread's; answered with `slack_history` with the same id. */
  | { t: 'slack_history'; id: string; channel: string; thread?: string }
  /** Marks the conversation read up to `ts`. */
  | { t: 'slack_mark'; channel: string; ts: string }
  /** Posts as the signed-in person, in the thread `thread` when given; answered with `slack_sent`. */
  | { t: 'slack_send'; id: string; channel: string; text: string; thread?: string }
  /** Switches the running session between work and casual; refused (in character) while work is still running. */
  | { t: 'chat_mode'; mode: ChatMode; compact?: boolean }
  /** The composer has a draft (on) or not any more (off): her own messages wait while anyone types. */
  | { t: 'typing'; on: boolean }
  /** Stores the casual API key in the link (never in settings); an empty key removes it. */
  | { t: 'casual_key'; key: string }
  /** Desktop only: turns phone access on or off; answered (to every desktop window) with `remote_status`. */
  | { t: 'remote_set'; enabled: boolean }
  /** Desktop only: a new pairing token; connected phones are dropped and must scan again. */
  | { t: 'remote_reset' }
  /** Desktop only: answered with `remote_status`. */
  | { t: 'remote_status' }
  /** Desktop only: removes a paired phone; it is disconnected and has to scan the code again. */
  | { t: 'remote_forget'; id: string }
  /**
   * Joins the session running now (a phone picking up the desktop's chat): answered with `attached`, then the
   * session's current state as ordinary session events (started with its history so far, ready, stats, todos,
   * open prompts…) under its epoch.
   */
  | { t: 'attach' }

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
  /** `love`: the love meter of the session's waifu card, in affection points. */
  | { t: 'started'; cwd: string; cwdShort: string; resumed: boolean; history: HistoryEntry[]; save?: Save; love?: number }
  /** Sent as soon as the CLI handshake completes (before the first turn). */
  /** `bypassAvailable`: the session was started with bypass permissions, so Shift+Tab may cycle to it, as in the CLI. */
  | { t: 'ready'; sessionId?: string; commands: Command[]; models: ModelChoice[]; mode: PermissionModeName; model?: string; account?: string; bypassAvailable?: boolean }
  | { t: 'session_id'; sessionId: string }
  | { t: 'commands'; commands: Command[] }
  | { t: 'face'; emotion: Emotion }
  /** She took the user's message as kind (+1) or unkind (-1): at most once per turn. */
  | { t: 'affection'; delta: 1 | -1 }
  /** The line she speaks for the paragraph being written (a <ja> line, removed from the text). */
  | { t: 'voice'; text: string }
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
  /** What another window sent her (a phone and the desktop both see each other's lines); never echoed to the sender. */
  | { t: 'said'; text: string; images?: number; shell?: boolean }
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
  /** The session's chat mode, after a `chat_mode` or on attach. */
  | { t: 'chat_mode'; mode: ChatMode }
  /** A prebuilt line of hers outside any reply (switching modes, or refusing to), shown as a line of its own. `voice`: its Japanese line. */
  | { t: 'aside'; text: string; voice?: string }
  /** She thinks the other mode fits what was just said; `text`: the message to send there if accepted. */
  | { t: 'offer_mode'; mode: ChatMode; text?: string }
  /** The CLI's greyed next-prompt suggestion, after a turn. */
  | { t: 'suggestion'; text: string }
  /** A hook running (PreToolUse, Stop…): the spinner names it; a failure is logged. */
  | { t: 'hook'; id: string; name: string; event: string; state: 'running' | 'ok' | 'error' | 'cancelled'; output?: string }

export type ServerMsg =
  /** `remote`: this window is a phone (phone access), so desktop-only things (folder pickers, Explorer) don't apply. */
  /**
   * `addresses`: to a phone, the computer's addresses right now (LAN, Tailscale…), so a pairing made on another
   * network, or before the router handed out a new address, keeps finding it.
   */
  | { t: 'hello'; version: string; settings: Settings; auth: Auth; dataDir: string; voiceKey: boolean; casualKey: boolean; slack: SlackStatus; remote: boolean; addresses?: string[] }
  /** One clip: base64 audio, or why there is none. */
  | { t: 'tts'; id: string; audio?: string; mime?: string; error?: string }
  /** Whether a Fish Audio key is stored now (after voice_key, to every window). */
  | { t: 'voice_key'; has: boolean }
  /** Whether a casual API key is stored now (after casual_key, to every window). */
  | { t: 'casual_key'; has: boolean }
  | { t: 'settings'; settings: Settings }
  | { t: 'auth'; auth: Auth }
  | { t: 'saves'; list: Save[] }
  | { t: 'cards'; list: CardSummary[]; active: string }
  /** How an export or import went: the card it was, or why it failed. */
  | { t: 'card_file'; op: 'export' | 'import'; id?: string; path: string; error?: string }
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
  /** To every window, whenever it changes. */
  | { t: 'slack_status'; status: SlackStatus }
  /** To every window as the scan finds changes, and to a `slack_inbox` request. */
  | { t: 'slack_inbox'; inbox: SlackInbox }
  | { t: 'slack_convs'; convs: SlackConv[]; error?: string }
  /** Oldest first. `lastRead`: the person's read cursor in the conversation, when Slack gives one. */
  | { t: 'slack_history'; id: string; channel: string; name?: string; messages?: SlackMessage[]; lastRead?: string; error?: string }
  | { t: 'slack_sent'; id: string; ok: boolean; error?: string }
  | { t: 'remote_status'; status: RemoteStatus }
  /** To a phone that just paired with the code: its own token, for good. It connects with this from now on. */
  | { t: 'paired'; token: string }
  /** The answer to `attach`: the running session's epoch, or none when nothing runs. */
  | { t: 'attached'; epoch?: number }
  /** Where an attachment was kept (`path`, for the message to mention), or why it wasn't (`error`). */
  | { t: 'file_put'; id: string; path?: string; error?: string }
  /**
   * After `attached`: everything the session did since it started, oldest first (text deltas joined), so a window
   * that joins or comes back from the background shows what the others show. Played without the typewriter.
   */
  | { t: 'replay'; epoch: number; events: SessionEvent[] }

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
