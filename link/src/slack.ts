import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { SlackConv, SlackConvKind, SlackInbox, SlackMessage, SlackStatus } from './protocol.ts'
import { DATA_DIR } from './settings.ts'
import { SLACK_REDIRECT_PORT, SLACK_REDIRECT_URL, SLACK_USER_SCOPES } from './slack-app.ts'

// Slack for the inbox viewer and her Slack tools, through Slack's public Web API only, signed in as the person
// with the workspace's own app (slack-app.ts). Slack's API terms shape this file:
// - No private endpoints and nothing taken from Slack's own clients. Slack has no public unread count for
//   channels, so the inbox scans each conversation in turn: its read cursor (`last_read`), then what came after it.
// - No archive: messages are only ever held in memory. The file keeps the token, who it belongs to, and a read
//   cursor (a message timestamp) for conversations Slack gives no `last_read` for.

const FILE = join(DATA_DIR, 'slack.json')
const API = 'https://slack.com/api'
const AUTHORIZE = 'https://slack.com/oauth/v2/authorize'
const REQUEST_TIMEOUT_MS = 15_000
const SIGNIN_TIMEOUT_MS = 5 * 60_000
/** Unread messages counted per conversation; past this the inbox says "20+". */
export const UNREAD_PEEK = 20
/** Messages a conversation or thread shows. */
const HISTORY_LIMIT = 40
/** How long the list of conversations is reused before it is fetched again. */
const CONVS_TTL_MS = 10 * 60_000
/** Pause between two scans of every conversation. */
const SCAN_GAP_MS = 60_000
/** An expiring token is refreshed this long before it lapses. */
const REFRESH_EARLY_MS = 5 * 60_000
const PUSH_DEBOUNCE_MS = 400
const CURSOR_SAVE_MS = 2_000
const PREVIEW_MAX = 140
const PAGE_LIMIT = 200
const RETRY_AFTER_S = 30
const MAX_ATTEMPTS = 3
// Gaps between two calls of one method, under Slack's per-method tiers (calls a minute: Tier 2 20, Tier 3 50,
// Tier 4 100; chat.postMessage about 1 a second).
const TIER2_MS = 3_200
const TIER3_MS = 1_300
const TIER4_MS = 650
const POST_MS = 1_100
const METHOD_GAP_MS: Record<string, number> = { 'users.info': TIER4_MS, 'auth.test': TIER4_MS, 'search.messages': TIER2_MS, 'chat.postMessage': POST_MS }
/** Slack errors meaning the token no longer works: the link signs out. */
const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'invalid_refresh_token'])
/** Message subtypes that are someone saying something (not joins, topic changes, pins…). */
const SPOKEN = new Set([undefined, 'bot_message', 'file_share', 'thread_broadcast', 'me_message'])

const MOCK = process.env.WC_MOCK === '1'

const NOT_SIGNED_IN = 'Slack isn\'t connected. Sign in from Settings → Slack.'
const ERRORS: Record<string, string> = {
  not_authed: 'Slack no longer accepts the sign-in. Sign in again from Settings → Slack.',
  invalid_auth: 'Slack no longer accepts the sign-in. Sign in again from Settings → Slack.',
  token_revoked: 'The Slack sign-in was revoked. Sign in again from Settings → Slack.',
  token_expired: 'The Slack sign-in expired. Sign in again from Settings → Slack.',
  invalid_refresh_token: 'The Slack sign-in expired. Sign in again from Settings → Slack.',
  account_inactive: 'That Slack account is deactivated.',
  missing_scope: 'The Slack app is missing a permission. Recreate it from the manifest in Settings → Slack, then sign in again.',
  channel_not_found: 'Slack can\'t find that conversation, or you\'re not in it.',
  not_in_channel: 'You\'re not in that channel.',
  is_archived: 'That channel is archived.',
  msg_too_long: 'That message is too long for Slack.',
  no_text: 'The message is empty.',
  ratelimited: 'Slack is rate limiting; try again in a minute.',
  invalid_client_id: 'Slack doesn\'t know that client ID. Copy it from the app\'s Basic Information page.',
  invalid_code: 'The sign-in code expired. Try again.',
  code_already_used: 'The sign-in code was already used. Try again.',
  bad_redirect_uri: `The Slack app doesn't list ${SLACK_REDIRECT_URL} as a redirect URL. Recreate it from the manifest in Settings → Slack.`,
  access_denied: 'You cancelled the sign-in in Slack.',
}

export class SlackError extends Error {
  code: string
  constructor(code: string, message = ERRORS[code] ?? `Slack said: ${code}`) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------- state

type Stored = {
  clientId: string
  token: string
  refreshToken?: string
  /** When the token lapses (ms); absent for a token that never expires (token rotation off). */
  expiresAt?: number
  teamId: string
  team: string
  url: string
  userId: string
  user: string
  /** Read cursors (message timestamps) for conversations Slack gives no `last_read` for. */
  cursors: Record<string, string>
}

type Tokens = { token: string; refreshToken?: string; expiresAt?: number }

type Conv = { id: string; name: string; kind: SlackConvKind }

let stored: Stored | undefined = load()
let signingIn = false
let lastError: string | undefined
let signin: { cancel(): void } | undefined
/** Bumped by every sign-in and sign-out: a scan or refresh from before stops instead of writing stale state. */
let gen = 0

const unread = new Map<string, SlackConv>()
let scanned = 0
let total = 0
let updatedAt = 0
let convCache: { at: number; list: Conv[] } | undefined
const people = new Map<string, Promise<string>>()

const statusSubs = new Set<(s: SlackStatus) => void>()
const inboxSubs = new Set<(i: SlackInbox) => void>()

function load(): Stored | undefined {
  try {
    if (!existsSync(FILE)) return undefined
    const s = JSON.parse(readFileSync(FILE, 'utf8')) as Stored
    return s.token && s.userId ? { ...s, cursors: s.cursors ?? {} } : undefined
  } catch (e) {
    console.warn('[slack] could not read the sign-in file:', e)
    return undefined
  }
}

let saving: Promise<unknown> = Promise.resolve()
/** Writes (or, signed out, removes) the file. One write at a time, so a late cursor save can't bring a token back. */
function save(): Promise<void> {
  const run = saving.then(async () => {
    const s = stored
    if (!s) return rm(FILE, { force: true })
    await mkdir(DATA_DIR, { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
    await rename(tmp, FILE)
  })
  saving = run.catch(() => {})
  return run
}

let cursorTimer: ReturnType<typeof setTimeout> | undefined
function setCursor(channel: string, ts: string) {
  if (!stored || stored.cursors[channel] === ts) return
  stored.cursors[channel] = ts
  clearTimeout(cursorTimer)
  cursorTimer = setTimeout(() => void save().catch((e) => console.warn('[slack] could not save read cursors:', e)), CURSOR_SAVE_MS)
}

export function status(): SlackStatus {
  return {
    signedIn: !!stored,
    signingIn,
    ...(stored ? { team: stored.team, user: stored.user, url: stored.url } : {}),
    ...(lastError ? { error: lastError } : {}),
  }
}

export function inbox(): SlackInbox {
  const order: Record<SlackConvKind, number> = { dm: 0, group: 1, private: 2, channel: 2 }
  const convs = [...unread.values()].sort((a, b) => order[a.kind] - order[b.kind] || tsCompare(b.preview?.ts, a.preview?.ts))
  return { convs, scanned, total, updatedAt }
}

export function onStatus(fn: (s: SlackStatus) => void) {
  statusSubs.add(fn)
  return () => void statusSubs.delete(fn)
}

export function onInbox(fn: (i: SlackInbox) => void) {
  inboxSubs.add(fn)
  return () => void inboxSubs.delete(fn)
}

function emitStatus() {
  const s = status()
  for (const fn of statusSubs) fn(s)
}

let pushTimer: ReturnType<typeof setTimeout> | undefined
function pushInbox() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    const i = inbox()
    for (const fn of inboxSubs) fn(i)
  }, PUSH_DEBOUNCE_MS)
}

// ---------------------------------------------------------------- calls

type Args = Record<string, string | number | boolean | undefined>

const nextAt = new Map<string, number>()
let pausedUntil = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Spaces out calls of one method under its rate tier, and holds everything after a 429. */
async function pace(method: string) {
  if (MOCK) return
  const now = Date.now()
  const at = Math.max(now, pausedUntil, nextAt.get(method) ?? 0)
  nextAt.set(method, at + (METHOD_GAP_MS[method] ?? TIER3_MS))
  if (at > now) await sleep(at - now)
}

async function post(method: string, args: Args, token?: string) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(args)) if (v !== undefined) body.set(k, String(v))
  try {
    return await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw new SlackError('network', e instanceof Error && e.name === 'TimeoutError' ? 'Slack took too long to answer.' : `Couldn't reach Slack: ${e instanceof Error ? e.message : e}`)
  }
}

/** One Web API call as the signed-in person. `token` signs it with a token that isn't stored yet (sign-in). */
async function call<T>(method: string, args: Args = {}, token?: string): Promise<T> {
  const mine = gen
  for (let attempt = 1; ; attempt++) {
    const s = stored
    const use = token ?? s?.token
    if (!use) throw new SlackError('not_authed', NOT_SIGNED_IN)
    if (MOCK) return mockApi(method, args) as T
    if (!token && s?.expiresAt && s.expiresAt - REFRESH_EARLY_MS < Date.now()) await refresh()
    await pace(method)
    const res = await post(method, args, token ?? stored?.token)
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      pausedUntil = Date.now() + (Number(res.headers.get('retry-after')) || RETRY_AFTER_S) * 1000
      continue
    }
    const j = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string }
    if (j.ok) return j as T
    const code = j.error ?? 'unknown_error'
    if (code === 'token_expired' && !token && stored?.refreshToken && attempt < MAX_ATTEMPTS) {
      await refresh()
      continue
    }
    // A token that stopped working signs the link out, unless a newer sign-in replaced it meanwhile.
    if (AUTH_ERRORS.has(code) && !token && mine === gen) dropAuth(ERRORS[code] ?? NOT_SIGNED_IN)
    throw new SlackError(code)
  }
}

/** oauth.v2.access: the sign-in's code exchange, or a refresh. Signed with no token; PKCE needs no secret. */
async function oauth(args: Args): Promise<Tokens> {
  const res = await post('oauth.v2.access', args)
  const j = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as {
    ok: boolean
    error?: string
    access_token?: string
    refresh_token?: string
    expires_in?: number
    authed_user?: { access_token?: string; refresh_token?: string; expires_in?: number }
  }
  if (!j.ok) throw new SlackError(j.error ?? 'unknown_error')
  // User-token installs put the token under authed_user; a refresh may answer at the top level.
  const u = j.authed_user ?? {}
  const token = u.access_token ?? j.access_token
  if (!token) throw new SlackError('no_token', 'Slack signed in but gave no user token. Check the app\'s user scopes.')
  const expiresIn = u.expires_in ?? j.expires_in
  return { token, refreshToken: u.refresh_token ?? j.refresh_token, ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}) }
}

let refreshing: Promise<void> | undefined
/** Swaps an expiring token (token rotation on) for a fresh one; one refresh at a time. */
function refresh(): Promise<void> {
  refreshing ??= (async () => {
    const s = stored
    if (!s?.refreshToken) throw new SlackError('token_expired')
    const mine = gen
    try {
      const t = await oauth({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId })
      if (mine !== gen || !stored) return
      stored = { ...stored, token: t.token, refreshToken: t.refreshToken ?? stored.refreshToken, expiresAt: t.expiresAt }
      await save()
    } catch (e) {
      if (e instanceof SlackError && AUTH_ERRORS.has(e.code) && mine === gen) dropAuth(e.message)
      throw e
    }
  })().finally(() => (refreshing = undefined))
  return refreshing
}

function dropAuth(reason: string) {
  gen++
  stored = undefined
  signingIn = false
  lastError = reason || undefined
  convCache = undefined
  people.clear()
  unread.clear()
  scanned = total = 0
  clearTimeout(cursorTimer)
  const removed = save().catch((e) => console.warn('[slack] could not remove the sign-in file:', e))
  emitStatus()
  pushInbox()
  return removed
}

// ---------------------------------------------------------------- sign-in

const b64url = (b: Buffer) => b.toString('base64url')

function page(res: ServerResponse, code: number, text: string) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Waifufy Code · Slack</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0"><p>${text}</p></body>`)
}

/** Opens Slack's consent page and waits for its redirect to the localhost callback (PKCE, no client secret). */
async function browserSignIn(clientId: string, open: (url: string) => void): Promise<Tokens> {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const url = `${AUTHORIZE}?${new URLSearchParams({
    client_id: clientId,
    user_scope: SLACK_USER_SCOPES.join(','),
    redirect_uri: SLACK_REDIRECT_URL,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`

  const code = await new Promise<string>((resolve, reject) => {
    const servers: Server[] = []
    let done = false
    let opened = false
    let failed = 0
    const finish = (err: Error | undefined, code?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const s of servers) s.close()
      signin = undefined
      if (err) reject(err)
      else resolve(code!)
    }
    const timer = setTimeout(() => finish(new SlackError('timeout', 'The Slack sign-in timed out. Try again.')), SIGNIN_TIMEOUT_MS)
    signin = { cancel: () => finish(new SlackError('cancelled', 'Sign-in cancelled.')) }
    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url ?? '/', SLACK_REDIRECT_URL)
      if (u.pathname !== '/slack/callback') return page(res, 404, 'Not found.')
      // Another tab, or an old sign-in: only the redirect for this one may finish it.
      if (u.searchParams.get('state') !== state) return page(res, 400, 'This Slack sign-in is out of date. Start it again from Waifufy Code.')
      const error = u.searchParams.get('error')
      const got = u.searchParams.get('code')
      if (error || !got) {
        page(res, 400, 'Slack didn\'t sign you in. You can close this tab.')
        return finish(new SlackError(error ?? 'no_code'))
      }
      page(res, 200, 'Signed in to Slack. You can close this tab and go back to Waifufy Code.')
      finish(undefined, got)
    }
    // "localhost" may resolve to either address, so both listen.
    const hosts = ['127.0.0.1', '::1']
    for (const host of hosts) {
      const s = createServer(onRequest)
      servers.push(s)
      s.on('error', () => {
        if (++failed === hosts.length) {
          finish(new SlackError('port_busy', `Port ${SLACK_REDIRECT_PORT} is in use, so Slack can't send the sign-in back. Close whatever uses it and try again.`))
        }
      })
      s.listen(SLACK_REDIRECT_PORT, host, () => {
        if (opened || done) return
        opened = true
        open(url)
      })
    }
  })
  return oauth({ client_id: clientId, code, code_verifier: verifier, redirect_uri: SLACK_REDIRECT_URL })
}

/** Signs in with the workspace's own Slack app; `status` follows along. Resolves once it finished or failed. */
export async function signIn(clientId: string, open: (url: string) => void) {
  const id = clientId.trim()
  signin?.cancel()
  lastError = undefined
  if (!id) {
    lastError = 'Paste the Slack app\'s client ID first.'
    return emitStatus()
  }
  signingIn = true
  emitStatus()
  const mine = ++gen
  try {
    const t = MOCK ? mockSignIn(id) : await browserSignIn(id, open)
    const who = await call<{ url: string; team: string; team_id: string; user_id: string; user: string }>('auth.test', {}, t.token)
    if (mine !== gen) return
    stored = { clientId: id, ...t, teamId: who.team_id, team: who.team, url: who.url, userId: who.user_id, user: who.user, cursors: stored?.teamId === who.team_id ? stored.cursors : {} }
    stored.user = await personName(who.user_id).catch(() => who.user)
    await save()
    console.log(`[slack] signed in to ${who.team} as ${stored.user}`)
    startScan()
  } catch (e) {
    if (mine !== gen) return
    lastError = e instanceof SlackError && e.code === 'cancelled' ? undefined : e instanceof Error ? e.message : String(e)
    console.warn('[slack] sign-in failed:', e instanceof Error ? e.message : e)
    // A failed sign-in over a working one keeps the old one going.
    if (stored) startScan()
  } finally {
    if (mine === gen) {
      signingIn = false
      emitStatus()
      pushInbox()
    }
  }
}

export function cancelSignIn() {
  signin?.cancel()
}

/** Revokes the token at Slack (best effort) and forgets it here. */
export async function signOut() {
  signin?.cancel()
  const s = stored
  if (s && !MOCK) await post('auth.revoke', {}, s.token).catch(() => undefined)
  await dropAuth('')
}

// ---------------------------------------------------------------- conversations, people, text

type RawConv = {
  id: string
  name?: string
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  is_user_deleted?: boolean
  user?: string
  last_read?: string
  latest?: { ts?: string } | null
  unread_count_display?: number
}

type RawMsg = {
  ts: string
  user?: string
  username?: string
  bot_profile?: { name?: string }
  subtype?: string
  text?: string
  reply_count?: number
  files?: { name?: string; title?: string }[]
}

/** Compares Slack timestamps ("1593473566.000200") exactly; a missing one sorts first. */
export function tsCompare(a: string | undefined, b: string | undefined) {
  if (a === b) return 0
  if (!a) return -1
  if (!b) return 1
  const [ai = '', af = ''] = a.split('.')
  const [bi = '', bf = ''] = b.split('.')
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
  // Digit strings of equal length compare like the numbers they spell.
  return ai.length - bi.length || cmp(ai, bi) || cmp(af.padEnd(6, '0'), bf.padEnd(6, '0'))
}

function personName(id: string): Promise<string> {
  let p = people.get(id)
  if (!p) {
    p = call<{ user: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>('users.info', { user: id })
      .then(({ user: u }) => u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || id)
    p.catch(() => people.delete(id))
    people.set(id, p)
  }
  return p
}

/** `mpdm-alice--bob--carol-1` → `alice, bob, carol`. */
const groupName = (raw: string) => raw.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ')

async function toConv(c: RawConv): Promise<Conv> {
  if (c.is_im) return { id: c.id, name: c.user ? await personName(c.user).catch(() => c.user!) : c.id, kind: 'dm' }
  if (c.is_mpim) return { id: c.id, name: groupName(c.name ?? c.id), kind: 'group' }
  return { id: c.id, name: `#${c.name ?? c.id}`, kind: c.is_private ? 'private' : 'channel' }
}

/** Every conversation the person is in, cached for a while. */
async function conversations(force = false): Promise<Conv[]> {
  if (!force && convCache && Date.now() - convCache.at < CONVS_TTL_MS) return convCache.list
  const list: Conv[] = []
  let cursor: string | undefined
  do {
    const r = await call<{ channels: RawConv[]; response_metadata?: { next_cursor?: string } }>('users.conversations', {
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true,
      limit: PAGE_LIMIT,
      cursor,
    })
    for (const c of r.channels) if (!c.is_user_deleted) list.push(await toConv(c))
    cursor = r.response_metadata?.next_cursor || undefined
  } while (cursor)
  convCache = { at: Date.now(), list }
  return list
}

const convById = (id: string) => convCache?.list.find((c) => c.id === id)

/** Slack's markup as plain text: `<@U1>` → `@Alice`, `<#C1|general>` → `#general`, `<url|label>` → `label (url)`. */
export async function plainText(text = '', name: (id: string) => Promise<string> = personName): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))]
  const names = new Map(await Promise.all(ids.map(async (id) => [id, await name(id).catch(() => id)] as const)))
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${names.get(id) ?? label ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => label ? `#${label}` : convById(id)?.name ?? `#${id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => label ?? '@group')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line
}

const author = (m: RawMsg) => (m.user ? personName(m.user).catch(() => m.user!) : Promise.resolve(m.bot_profile?.name || m.username || 'bot'))

async function toMessage(m: RawMsg): Promise<SlackMessage> {
  const files = (m.files ?? []).map((f) => f.title || f.name || 'file')
  return {
    ts: m.ts,
    user: await author(m),
    text: await plainText(m.text),
    mine: !!stored && m.user === stored.userId,
    ...(m.reply_count ? { replies: m.reply_count } : {}),
    ...(files.length ? { files } : {}),
  }
}

// ---------------------------------------------------------------- the inbox scan

let scanWake: (() => void) | undefined
let rescan = false

function startScan() {
  const mine = gen
  unread.clear()
  scanned = total = 0
  void (async () => {
    while (mine === gen && stored) {
      try {
        await scanAll(mine)
      } catch (e) {
        if (mine === gen) console.warn('[slack] inbox scan failed:', e instanceof Error ? e.message : e)
      }
      if (mine !== gen) return
      if (rescan) {
        rescan = false
        continue
      }
      await new Promise<void>((r) => {
        const timer = setTimeout(r, SCAN_GAP_MS)
        scanWake = () => (clearTimeout(timer), r())
      })
      scanWake = undefined
    }
  })()
}

/** Rescans every conversation now (or right after the scan running). */
export function refreshInbox() {
  if (!stored) return
  convCache = undefined
  if (scanWake) scanWake()
  else rescan = true
}

async function scanAll(mine: number) {
  const list = await conversations()
  if (mine !== gen) return
  // DMs and group DMs first: they are the likeliest to be waiting on the person.
  const rank = (c: Conv) => (c.kind === 'dm' ? 0 : c.kind === 'group' ? 1 : 2)
  const order = [...list].sort((a, b) => rank(a) - rank(b))
  const ids = new Set(list.map((c) => c.id))
  for (const id of unread.keys()) if (!ids.has(id)) unread.delete(id)
  total = order.length
  scanned = 0
  for (const c of order) {
    if (mine !== gen) return
    try {
      const entry = await scanConv(c)
      if (mine !== gen) return
      if (entry) unread.set(c.id, entry)
      else unread.delete(c.id)
    } catch (e) {
      // One conversation failing (left meanwhile, a missing scope) shouldn't stop the others.
      if (e instanceof SlackError && AUTH_ERRORS.has(e.code)) throw e
      console.warn(`[slack] could not scan ${c.name}:`, e instanceof Error ? e.message : e)
    }
    scanned++
    pushInbox()
  }
  updatedAt = Date.now()
  pushInbox()
}

/** The read cursor: Slack's own `last_read`, else the one kept here (started at the newest message, first seen). */
async function readCursor(c: { id: string }, info: RawConv) {
  if (info.last_read && info.last_read !== '0000000000.000000') return info.last_read
  const kept = stored?.cursors[c.id]
  if (kept) return kept
  const newest = info.latest?.ts ?? (await call<{ messages: RawMsg[] }>('conversations.history', { channel: c.id, limit: 1 })).messages[0]?.ts ?? '0'
  setCursor(c.id, newest)
  return newest
}

/** What's unread in one conversation, or undefined when nothing is. */
async function scanConv(c: Conv): Promise<SlackConv | undefined> {
  const { channel: info } = await call<{ channel: RawConv }>('conversations.info', { channel: c.id })
  const lastRead = await readCursor(c, info)
  if (info.latest?.ts && tsCompare(info.latest.ts, lastRead) <= 0) return undefined
  if (c.kind === 'dm' && info.unread_count_display === 0) return undefined
  const h = await call<{ messages: RawMsg[]; has_more?: boolean }>('conversations.history', { channel: c.id, oldest: lastRead, inclusive: false, limit: UNREAD_PEEK + 1 })
  const fresh = h.messages.filter((m) => SPOKEN.has(m.subtype) && m.user !== stored?.userId && tsCompare(m.ts, lastRead) > 0)
  if (!fresh.length) return undefined
  const newest = fresh[0]!
  const me = stored?.userId
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    unread: Math.min(fresh.length, UNREAD_PEEK),
    more: fresh.length > UNREAD_PEEK || !!h.has_more,
    mention: c.kind === 'dm' || (!!me && fresh.some((m) => m.text?.includes(`<@${me}>`))),
    preview: { user: await author(newest), text: oneLine(await plainText(newest.text)), ts: newest.ts },
  }
}

// ---------------------------------------------------------------- reading and writing

/** A conversation by id, `#name`, a person's name (their DM) or a group DM's members. */
export async function resolve(ref: string): Promise<Conv> {
  const r = ref.trim()
  if (!r) throw new SlackError('channel_not_found')
  const list = await conversations()
  if (/^[CDG][A-Z0-9]{6,}$/.test(r)) return list.find((c) => c.id === r) ?? { id: r, name: r, kind: r.startsWith('D') ? 'dm' : 'channel' }
  const bare = r.replace(/^[#@]/, '').toLowerCase()
  const hit = list.find((c) => c.name.replace(/^#/, '').toLowerCase() === bare)
    ?? list.find((c) => c.kind === 'dm' && c.name.toLowerCase().startsWith(bare))
  if (!hit) throw new SlackError('channel_not_found', `No conversation called "${r}" that you're in. Use #channel, the name of someone you have a DM with, or a channel ID.`)
  return hit
}

/** Every conversation, with what the scan found unread so far. */
export async function allConversations(): Promise<SlackConv[]> {
  const list = await conversations()
  return list.map((c) => unread.get(c.id) ?? { id: c.id, name: c.name, kind: c.kind, unread: 0, more: false, mention: false })
}

/** The latest messages of a conversation (or a thread's, from its start), oldest first. */
export async function history(channel: string, thread?: string) {
  const c = await resolve(channel)
  if (thread) {
    const r = await call<{ messages: RawMsg[] }>('conversations.replies', { channel: c.id, ts: thread, limit: HISTORY_LIMIT })
    return { conv: c, messages: await Promise.all(r.messages.filter((m) => SPOKEN.has(m.subtype)).map(toMessage)), lastRead: undefined }
  }
  const [r, info] = await Promise.all([
    call<{ messages: RawMsg[] }>('conversations.history', { channel: c.id, limit: HISTORY_LIMIT }),
    call<{ channel: RawConv }>('conversations.info', { channel: c.id }).then((x) => x.channel).catch(() => undefined),
  ])
  const messages = await Promise.all(r.messages.filter((m) => SPOKEN.has(m.subtype)).reverse().map(toMessage))
  const lastRead = info?.last_read && info.last_read !== '0000000000.000000' ? info.last_read : stored?.cursors[c.id]
  return { conv: c, messages, lastRead }
}

/** Marks a conversation read up to `ts` (its newest message when omitted). */
export async function markRead(channel: string, ts?: string) {
  const c = await resolve(channel)
  const upTo = ts || (await call<{ messages: RawMsg[] }>('conversations.history', { channel: c.id, limit: 1 })).messages[0]?.ts
  if (!upTo) return c
  await call('conversations.mark', { channel: c.id, ts: upTo })
  setCursor(c.id, upTo)
  const entry = unread.get(c.id)
  if (entry && tsCompare(entry.preview?.ts, upTo) <= 0) unread.delete(c.id)
  pushInbox()
  return c
}

/** Posts as the signed-in person. */
export async function send(channel: string, text: string, thread?: string) {
  if (!text.trim()) throw new SlackError('no_text')
  const c = await resolve(channel)
  const r = await call<{ ts: string; channel: string }>('chat.postMessage', { channel: c.id, text, thread_ts: thread || undefined })
  // Answering a conversation reads it, as in Slack.
  if (!thread) await markRead(c.id, r.ts).catch(() => undefined)
  return { conv: c, ts: r.ts }
}

export type SlackHit = { channel: string; user: string; text: string; ts: string; permalink?: string }

/** Slack's message search, with its modifiers (`in:#general from:@alice after:2026-10-01`). */
export async function search(query: string, count = 20): Promise<SlackHit[]> {
  const r = await call<{ messages: { matches: { channel?: { id: string; name?: string }; user?: string; username?: string; text?: string; ts: string; permalink?: string }[] } }>(
    'search.messages',
    { query, count, sort: 'timestamp' },
  )
  return Promise.all(r.messages.matches.map(async (m) => ({
    channel: m.channel ? convById(m.channel.id)?.name ?? `#${m.channel.name ?? m.channel.id}` : '?',
    user: m.user ? await personName(m.user).catch(() => m.username ?? m.user!) : m.username ?? '?',
    text: await plainText(m.text),
    ts: m.ts,
    ...(m.permalink ? { permalink: m.permalink } : {}),
  })))
}

/** A link that opens the conversation in the Slack app. */
export const slackLink = (channel: string) => (stored ? `https://slack.com/app_redirect?channel=${channel}&team=${stored.teamId}` : '')

/** Starts the inbox scan when the link starts already signed in. */
export function startSlack() {
  if (stored) startScan()
}

// ---------------------------------------------------------------- mock (E2E)

const ME = 'U0ME'
type MockConv = { raw: RawConv; messages: RawMsg[] }
const mockPeople: Record<string, string> = { [ME]: 'You', U0ALICE: 'Alice', U0BOB: 'Bob' }
let mockTs = 1_700_000_100
const mockMsg = (user: string, text: string, extra: Partial<RawMsg> = {}): RawMsg => ({ ts: `${mockTs++}.000100`, user, text, ...extra })
let mockConvs: MockConv[] | undefined

function mockData(): MockConv[] {
  mockConvs ??= [
    { raw: { id: 'D0ALICE', is_im: true, user: 'U0ALICE' }, messages: [mockMsg(ME, 'Morning!'), mockMsg('U0ALICE', 'Did the deploy go out?'), mockMsg('U0ALICE', 'Ping me when it\'s live <https://example.com/status|status page>')] },
    { raw: { id: 'C0GENERAL', name: 'general' }, messages: [mockMsg('U0BOB', 'Standup in 5'), mockMsg('U0ALICE', 'Lunch?', { reply_count: 2 }), mockMsg('U0BOB', '<@U0ME> can you review #42?'), mockMsg('U0ALICE', 'Shipped the fix')] },
    { raw: { id: 'C0RANDOM', name: 'random' }, messages: [mockMsg('U0BOB', 'cat pictures')] },
    { raw: { id: 'G0TEAM', is_mpim: true, name: 'mpdm-alice--bob--you-1' }, messages: [mockMsg('U0BOB', 'Retro notes are up')] },
  ]
  // What the person had read: everything in #random, the first message elsewhere.
  for (const c of mockConvs) c.raw.last_read ??= c.raw.id === 'C0RANDOM' ? c.messages.at(-1)!.ts : c.messages[0]!.ts
  return mockConvs
}

function mockSignIn(clientId: string): Tokens {
  if (clientId === 'mock-fail') throw new SlackError('invalid_client_id')
  return { token: 'xoxp-mock' }
}

function mockApi(method: string, a: Args): unknown {
  const convs = mockData()
  const conv = (id: unknown) => {
    const c = convs.find((x) => x.raw.id === id)
    if (!c) throw new SlackError('channel_not_found')
    return c
  }
  const newestFirst = (list: RawMsg[]) => [...list].reverse()
  switch (method) {
    case 'auth.test':
      return { ok: true, url: 'https://mock.slack.com/', team: 'Mock Team', team_id: 'T0MOCK', user: 'you', user_id: ME }
    case 'users.info':
      return { ok: true, user: { name: mockPeople[String(a.user)] ?? String(a.user) } }
    case 'users.conversations':
      return { ok: true, channels: convs.map((c) => c.raw) }
    case 'conversations.info': {
      const c = conv(a.channel)
      return { ok: true, channel: { ...c.raw, latest: { ts: c.messages.at(-1)?.ts } } }
    }
    case 'conversations.history': {
      const c = conv(a.channel)
      const after = c.messages.filter((m) => !a.oldest || tsCompare(m.ts, String(a.oldest)) > 0)
      return { ok: true, messages: newestFirst(after).slice(0, Number(a.limit) || HISTORY_LIMIT) }
    }
    case 'conversations.replies': {
      const c = conv(a.channel)
      const parent = c.messages.find((m) => m.ts === a.ts)
      if (!parent) throw new SlackError('thread_not_found')
      return { ok: true, messages: [parent, mockMsg('U0BOB', 'Yes please'), mockMsg('U0ALICE', 'Noodles?')] }
    }
    case 'conversations.mark':
      conv(a.channel).raw.last_read = String(a.ts)
      return { ok: true }
    case 'chat.postMessage': {
      const c = conv(a.channel)
      const m = mockMsg(ME, String(a.text))
      if (!a.thread_ts) c.messages.push(m)
      return { ok: true, ts: m.ts, channel: c.raw.id }
    }
    case 'search.messages': {
      const q = String(a.query).toLowerCase()
      const matches = convs.flatMap((c) => c.messages.filter((m) => m.text?.toLowerCase().includes(q)).map((m) => ({ ...m, channel: { id: c.raw.id, name: c.raw.name } })))
      return { ok: true, messages: { matches } }
    }
    default:
      throw new SlackError('unknown_method')
  }
}
