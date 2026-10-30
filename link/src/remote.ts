import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { RemoteStatus } from './protocol.ts'
import { DATA_DIR } from './settings.ts'

// Phone access: the Android app is a second window onto this link, over the network. It is off until turned on in
// Settings → Phone; then server.ts listens on REMOTE_PORT on every interface. The pairing QR code carries a pairing
// token (never the desktop page's): a phone shows it once and gets a device token of its own back, which it keeps for
// good. So a new pairing code changes only what new phones scan, and each phone can be removed on its own. The tokens
// live in their own file, like the other secrets.

/** Fixed, so a paired phone finds the desktop again after a restart. */
/** WC_REMOTE_PORT moves it, so a test link can pair a phone while the installed app holds the usual port. */
export const REMOTE_PORT = Number(process.env.WC_REMOTE_PORT) || 47920
const FILE = join(DATA_DIR, 'remote.json')
const TOKEN_BYTES = 24

/** A paired phone. `token` is its own, for good; the rest is for the list in Settings → Phone. */
type Device = { id: string; name: string; token: string; pairedAt: number; lastSeen: number }
type Stored = { enabled: boolean; token: string; devices: Device[] }
/** Phones a computer keeps; pairing one more forgets the one seen longest ago. */
const MAX_DEVICES = 20
/** How often a device's "last seen" reaches the file. */
const SEEN_SAVE_MS = 60_000

let stored: Stored = load()

function load(): Stored {
  try {
    if (existsSync(FILE)) {
      const s = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Stored>
      const devices = Array.isArray(s.devices) ? s.devices.filter((d) => d && typeof d.token === 'string' && typeof d.id === 'string') : []
      if (s.token) return { enabled: s.enabled === true, token: s.token, devices }
    }
  } catch (e) {
    console.warn('[remote] could not read the phone access file:', e)
  }
  return { enabled: false, token: newToken(), devices: [] }
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

/** A new pairing code: new phones scan it; the phones already paired keep their own tokens. */
export async function resetRemoteToken() {
  stored = { ...stored, token: newToken() }
  await save()
}

const same = (given: string, token: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Who a phone's token says it is: a paired device, a phone pairing with the code ('pair'), or nobody. */
export function phoneAuth(given: string): { device: Device } | 'pair' | undefined {
  if (!given) return undefined
  const device = stored.devices.find((d) => same(given, d.token))
  if (device) return { device }
  return same(given, stored.token) ? 'pair' : undefined
}

/** A phone that showed the pairing code becomes a device with a token of its own. */
export async function addDevice(name: string): Promise<Device> {
  const now = Date.now()
  const device: Device = { id: randomBytes(6).toString('hex'), name: name.slice(0, 60) || 'Phone', token: newToken(), pairedAt: now, lastSeen: now }
  const kept = [...stored.devices].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_DEVICES - 1)
  stored = { ...stored, devices: [...kept, device] }
  await save()
  return device
}

export async function removeDevice(id: string) {
  stored = { ...stored, devices: stored.devices.filter((d) => d.id !== id) }
  await save()
}

let seenTimer: ReturnType<typeof setTimeout> | undefined
/** A device just connected or spoke: its "last seen" moves on, written to the file now and then. */
export function sawDevice(id: string) {
  const d = stored.devices.find((x) => x.id === id)
  if (!d) return
  d.lastSeen = Date.now()
  seenTimer ??= setTimeout(() => {
    seenTimer = undefined
    void save().catch((e) => console.warn('[remote] could not save the devices:', e))
  }, SEEN_SAVE_MS)
}

/** A phone's model from its browser string ("…; Android 15; CPH2711 Build/…"), for the device list. */
export function deviceName(userAgent = '') {
  const m = /Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/|\))/.exec(userAgent)
  return (m?.[1] ?? (/iPhone|iPad/.exec(userAgent)?.[0] ?? 'Phone')).trim()
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

/** `online`: ids of the devices connected right now. */
export function remoteStatus(listening: boolean, clients: number, error?: string, online: Set<string> = new Set()): RemoteStatus {
  const hosts = addresses()
  return {
    enabled: stored.enabled,
    listening,
    port: REMOTE_PORT,
    addresses: hosts,
    clients,
    devices: stored.devices
      .map(({ id, name, pairedAt, lastSeen }) => ({ id, name, pairedAt, lastSeen, online: online.has(id) }))
      .sort((a, b) => b.lastSeen - a.lastSeen),
    ...(stored.enabled ? { pairUrl: pairUrl(hosts) } : {}),
    ...(error ? { error } : {}),
  }
}
