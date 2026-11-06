// Serves a mod's ui/ folder and the bridge SDK to the sandboxed panel iframes. These routes skip the link token
// (an iframe can't send it); each mod's files need that mod's own `pt` token instead.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DiscoveredMod } from './discover.ts'

const SDK = fileURLToPath(new URL('./sdk/waifufy.js', import.meta.url))
const tokens = new Map<string, string>()

/** The token that opens one mod's panel files. */
export function panelToken(id: string): string {
  let t = tokens.get(id)
  if (!t) tokens.set(id, (t = randomBytes(16).toString('hex')))
  return t
}

export function checkPanelToken(id: string, token: string): boolean {
  const want = Buffer.from(panelToken(id))
  const given = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra })
  res.end(body)
}

/** Handles /mods/_sdk/waifufy.js and /mods/<id>/ui/...?pt=. Returns false for any other path. */
export function serveMod(req: IncomingMessage, res: ServerResponse, mods: () => DiscoveredMod[]): boolean {
  const url = new URL(req.url ?? '/', 'http://link')
  if (!url.pathname.startsWith('/mods/')) return false
  void handle(url, res, mods).catch(() => send(res, 404, 'not found'))
  return true
}

async function handle(url: URL, res: ServerResponse, mods: () => DiscoveredMod[]) {
  if (url.pathname === '/mods/_sdk/waifufy.js') return send(res, 200, await readFile(SDK), TYPES['.js'])
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return send(res, 404, 'not found')
  }
  const [, , id, ui, ...rest] = path.split('/')
  const mod = mods().find((m) => m.id === id && m.status === 'ok')
  if (!mod || ui !== 'ui' || !rest.length) return send(res, 404, 'not found')
  if (!checkPanelToken(mod.id, url.searchParams.get('pt') ?? '')) return send(res, 403, 'forbidden')
  if (rest.some((s) => s === '..' || s.includes('\\') || s.includes('\0'))) return send(res, 404, 'not found')
  const base = resolve(mod.dir, 'ui')
  const file = resolve(base, ...rest)
  if (!file.startsWith(base + sep)) return send(res, 404, 'not found')
  const type = TYPES[extname(file).toLowerCase()]
  if (!type) return send(res, 404, 'not found')
  const body = await readFile(file)
  send(res, 200, body, type, type.startsWith('text/html') ? { 'Content-Security-Policy': "default-src 'self'; connect-src 'none'" } : {})
}
