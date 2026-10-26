// Interfaces between the app's modules. Each module is implemented in its own folder and only
// talks to the others through these types (plus link/src/protocol.ts for the wire format).

import type { ClientMsg, Costume, Emotion, ServerMsg, Settings } from '../../link/src/protocol.ts'
import type { Slack } from './slack'
import type { Voice } from './voice'

// ---------------------------------------------------------------- link (app/src/link.ts)

export type Link = {
  /** HTTP base of the sidecar, e.g. http://127.0.0.1:51234. Models and thumbnails are served from here. */
  base: string
  send(m: ClientMsg): void
  /** Subscribes to every server message; returns an unsubscribe function. */
  on(handler: (m: ServerMsg) => void): () => void
  /** Resolves with the next message matching `pred` (e.g. a reply). */
  next<T extends ServerMsg>(pred: (m: ServerMsg) => m is T, timeoutMs?: number): Promise<T>
  /** 'up' once connected; 'down' while reconnecting (sidecar crashed or restarting). */
  onStatus(handler: (status: 'up' | 'down') => void): () => void
}

// ---------------------------------------------------------------- settings store (app/src/state.ts)

export type Store = {
  get(): Settings
  /** Applies a change locally, notifies subscribers, and persists it (debounced). */
  update(mutate: (s: Settings) => void): void
  subscribe(fn: (s: Settings) => void): () => void
}

// ---------------------------------------------------------------- character (app/src/character/)

/** One-shot gestures for app events (R35). */
export type Gesture =
  | 'confirm' // a permission prompt or question appears
  | 'danger' // a destructive command is about to run
  | 'push' // git push succeeded
  | 'success' // a long turn finished well
  | 'fail' // an error
  | 'interrupt' // the user stopped her
  | 'greet' // a session starts / the title screen appears
  | 'costume' // right after a costume change

export type Placement = 'title' | 'chat' | 'side' | 'hidden'

export type Character = {
  /** Resolves when the first model is loaded (or the placeholder is shown). Never rejects. */
  ready: Promise<void>
  /** True when a real Live2D model is shown, false for the placeholder sprite. */
  hasModel(): boolean
  costumes(): Costume[]
  /** Loads and swaps to a costume, keeping the current emotion. */
  setCostume(id: string): Promise<void>
  /** Inline emotion from the dialogue timeline: plays its enter gesture, then holds it. */
  emote(e: Emotion): void
  gesture(g: Gesture): void
  /** Lip sync while the typewriter prints letters (R28). */
  setTalking(on: boolean): void
  /** While the agent works: holds a working pose between lines; headpats scold instead (R33, R35). */
  setBusy(on: boolean): void
  setPlacement(p: Placement): void
  /** A JPEG data URL of the character on the current backdrop, for save thumbnails. */
  snapshot(width: number, height: number): Promise<string | undefined>
  /** While her voice plays: her mouth follows this loudness (0–1); undefined hands it back to the typewriter. */
  setVoiceLevel(level: (() => number) | undefined): void
  /** Calls `fn` when a headpat begins while she is free; returns the unsubscribe. */
  onHeadpat(fn: () => void): () => void
}

// ---------------------------------------------------------------- screens (app/src/screens/, app/src/chat/)

export type ScreenName = 'title' | 'saves' | 'settings' | 'chat' | 'wizard'

export type Router = {
  go(screen: ScreenName, params?: Record<string, unknown>): void
  current(): ScreenName
  /** Returns to the previous screen (Esc / Return buttons). */
  back(): void
}

/** What every screen receives. */
export type Ctx = {
  link: Link
  store: Store
  character: Character
  router: Router
  /** Her voice (app/src/voice.ts). */
  voice: Voice
  /** The Slack sign-in and unread inbox (app/src/slack.ts). */
  slack: Slack
  /** Shows a transient message at the top of the stage. */
  toast(text: string, ms?: number): void
  /** A VN-style yes/no dialog; resolves true for yes. */
  confirm(title: string, body: string, yes?: string, no?: string): Promise<boolean>
  /** Opens the OS folder picker; resolves '' when cancelled. */
  pickFolder(title: string, defaultPath?: string): Promise<string>
  /** Opens the OS file picker for images; resolves data URLs. */
  pickImages(multiple: boolean): Promise<{ name: string; dataUrl: string }[]>
}

export type Screen = {
  /** Called once with the screen's own root element (already in the DOM, hidden). */
  mount(root: HTMLElement, ctx: Ctx): void
  /** Called every time the screen becomes visible. */
  show(params?: Record<string, unknown>): void
  /** Called when another screen takes over. */
  hide(): void
  /** Esc pressed while this screen is on top and no overlay handled it. Return true if handled. */
  onEscape?(): boolean
}

/** Starting a session goes through the chat screen: router.go('chat', ChatParams). */
export type ChatParams = { cwd: string; resume?: string; title?: string }
