import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Rem's model, voices and waifufy.config.json come from the waifufy checkout next to this repo.
const HOME = resolve(process.env.WAIFUFY_HOME ?? join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'waifufy'))
const ASSETS = join(HOME, 'assets')

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.moc3': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

function reply(res: ServerResponse, status: number, body: Buffer | string, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

/** Serves `/config` and `/assets/*`, refusing paths that climb out of the assets folder. */
export async function serveAsset(pathname: string, res: ServerResponse) {
  let file: string
  if (pathname === '/config') {
    file = join(HOME, 'waifufy.config.json')
  } else {
    file = normalize(join(ASSETS, decodeURIComponent(pathname.slice('/assets/'.length))))
    if (!file.startsWith(ASSETS + sep)) return reply(res, 403, 'forbidden')
  }
  try {
    let body: Buffer = await readFile(file)
    if (file.endsWith('.motion3.json')) body = fixMotionMeta(body)
    reply(res, 200, body, MIME[extname(file)] ?? 'application/octet-stream')
  } catch {
    reply(res, 404, 'not found')
  }
}

type Motion = {
  Meta?: Record<string, unknown>
  Curves?: { Segments?: number[] }[]
  UserData?: { Value?: string }[]
}

/**
 * Recounts a motion3.json's `Meta` totals from its curves. Models ripped from games often carry wrong
 * counts, and the Cubism framework sizes its buffers from them, so a wrong count fails the parse.
 * Same fix as waifufy's overlay server.
 */
function fixMotionMeta(bytes: Buffer): Buffer {
  let motion: Motion
  try {
    motion = JSON.parse(bytes.toString('utf8'))
  } catch {
    return bytes
  }
  const curves = motion.Curves ?? []
  let segments = 0
  let points = 0
  for (const curve of curves) {
    const s = curve.Segments ?? []
    if (s.length < 2) continue
    points += 1 // the curve's first point
    let i = 2
    while (i < s.length) {
      // Bezier: two control points and the end point. Linear, stepped, inverse stepped: one point.
      const isBezier = s[i] === 1
      segments += 1
      points += isBezier ? 3 : 1
      i += isBezier ? 7 : 3
    }
  }
  const userData = motion.UserData ?? []
  if (motion.Meta) {
    motion.Meta.CurveCount = curves.length
    motion.Meta.TotalSegmentCount = segments
    motion.Meta.TotalPointCount = points
    motion.Meta.UserDataCount = userData.length
    motion.Meta.TotalUserDataSize = userData.reduce((n, u) => n + (u.Value?.length ?? 0), 0)
  }
  return Buffer.from(JSON.stringify(motion))
}
