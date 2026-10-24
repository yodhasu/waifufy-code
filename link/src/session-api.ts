import type { CtlOp, Image, PermissionModeName, SessionEvent, Settings } from './protocol.ts'

/** Contract between server.ts and a session implementation: session.ts (real SDK) or mock.ts (E2E tests). */
export type SessionOptions = {
  /** Chosen by the app in `start`; server.ts tags every emitted event with it. */
  epoch: number
  cwd: string
  resume?: string
  /** With `resume`: keep the transcript up to and including this entry (a rewind). */
  resumeAt?: string
  /** With `resumeAt`: the prompt whose turn the rewind drops. */
  dropsTurn?: string
  settings: Settings
  /** Full path to the Claude Code executable (bundled claude.exe in release); undefined = SDK default lookup. */
  claudePath?: string
  emit(e: SessionEvent): void
}

export interface SessionApi {
  readonly epoch: number
  readonly cwd: string
  /** Current SDK session id; changes after /clear. */
  sessionId(): string | undefined
  /** Starts the CLI and completes the handshake; emits `ready` (and `stats`). Never throws: failures are emitted as `error` + `ended`. */
  start(): Promise<void>
  /** `now`: while a turn runs, deliver it to that turn at once (the CLI's Ctrl+Enter) instead of after it. */
  say(text: string, images?: Image[], now?: boolean): void
  /** `!cmd`: runs it in `cwd`, emits `shell_result`, and appends input+output to context without a turn. */
  shell(command: string): Promise<void>
  interrupt(): Promise<void>
  /** Intentional shutdown: no `error` for the resulting abort; emits `ended` with reason 'closed'. */
  close(): void
  setMode(mode: PermissionModeName): Promise<void>
  setModel(model: string): Promise<void>
  answerPermission(id: string, decision: 'allow' | 'always' | 'deny' | 'feedback', message?: string, option?: string): void
  answerQuestion(id: string, answers: Record<string, string>): void
  /** Calls an SDK session control (CTL_OPS); rejects with its error. */
  control(op: CtlOp, args: unknown[]): Promise<unknown>
  /** The user's answer to an `ask_elicit`; throws when an accepted form doesn't fit the server's schema. */
  answerElicit(id: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): void
  answerPlan(id: string, decision: 'auto' | 'manual' | 'keep', message?: string): void
}

export type SessionFactory = (opts: SessionOptions) => SessionApi
