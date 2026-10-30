import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { RemoteStatus } from './protocol.ts'
import { DATA_DIR } from './settings.ts'

// Phone access: the Android app is a second window onto this link, over the network. It is off until turned on in
// Settings → Phone; then server.ts listens on REMOTE_PORT on every interface, behind its own token (never the
// desktop page's), which the pairing QR code carries. The token lives in its own file, like the other secrets.

/** Fixed, so a paired phone finds the desktop again after a restart. */
/** WC_REMOTE_PORT moves it, so a test link can pair a phone while the installed app holds the usual port. */
export const REMOTE_PORT = Number(process.env.WC_REMOTE_PORT) || 47920
const FILE = join(DATA_DIR, 'remote.json')
const TOKEN_BYTES = 24

type Stored = { enabled: boolean; token: string }

let stored: Stored = load()

function load(): Stored {
  try {
    if (existsSync(FILE)) {
      const s = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Stored>
      if (s.token) return { enabled: s.enabled === true, token: s.token }
    }
  } catch (e) {
    console.warn('[remote] could not read the phone access file:', e)
  }
  return { enabled: false, token: newToken() }
}

function newToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

async function save() {
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(stored), { mode: 0o600 })
  await rename(tmp, FILE)
}

export const remoteEnabled = () => stored.enabled

export async function setRemoteEnabled(enabled: boolean) {
  stored = { ...stored, enabled }
  await save()
}

/** A new token: every paired phone has to scan the new code. */
export async function resetRemoteToken() {
  stored = { ...stored, token: newToken() }
  await save()
}

export function remoteTokenOk(given: string) {
  const a = Buffer.from(given)
  const b = Buffer.from(stored.token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The addresses a phone can reach this computer at: private LAN ranges first, then Tailscale's (100.64/10, which
 * also works away from home), then anything else that isn't loopback.
 */
export function addresses(): string[] {
  const all = Object.values(networkInterfaces()).flatMap((list) => list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address)
  const rank = (ip: string) => {
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return 0
    const [a, b] = ip.split('.').map(Number)
    if (a === 100 && b! >= 64 && b! < 128) return 1
    return /^169\.254\./.test(ip) ? 3 : 2
  }
  return [...new Set(all)].sort((x, y) => rank(x) - rank(y))
}

/** What the phone scans: every address to try, the port and the token. */
export function pairUrl(hosts = addresses()) {
  return `waifufy-code://pair?${new URLSearchParams({ h: hosts.join(','), p: String(REMOTE_PORT), t: stored.token })}`
}

export function remoteStatus(listening: boolean, clients: number, error?: string): RemoteStatus {
  const hosts = addresses()
  return {
    enabled: stored.enabled,
    listening,
    port: REMOTE_PORT,
    addresses: hosts,
    clients,
    ...(stored.enabled ? { pairUrl: pairUrl(hosts) } : {}),
    ...(error ? { error } : {}),
  }
}
