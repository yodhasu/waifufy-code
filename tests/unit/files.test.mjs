// Any-file attachments: a window sends a file's bytes (`file_put`), the link keeps it under the data folder and
// answers with the path the message mentions. Against a real link process in mock mode.
// Run: node tests/unit/files.test.mjs (no app, no Claude).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute, basename } from 'node:path'

const require = createRequire(new URL('../../link/package.json', import.meta.url))
const { WebSocket } = require('ws')

const dir = mkdtempSync(join(tmpdir(), 'wc-files-'))
const PORT = 47993
const TOKEN = 'desktop-token'
const link = spawn(process.execPath, ['link/src/server.ts'], {
  cwd: new URL('../..', import.meta.url),
  env: { ...process.env, WC_PORT: String(PORT), WC_TOKEN: TOKEN, WC_DATA_DIR: dir, WC_MOCK: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let linkLog = ''
link.stdout.on('data', (d) => (linkLog += d))
link.stderr.on('data', (d) => (linkLog += d))

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.stack ?? e.message}`)
  }
}
const ok = (v, msg) => {
  if (!v) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error(`the link never came up:\n${linkLog}`)
}

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
    const got = []
    ws.on('message', (raw) => got.push(JSON.parse(String(raw))))
    ws.on('open', () => resolve({
      send: (m) => ws.send(JSON.stringify(m)),
      next: async (pred, ms = 5000) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
          const m = got.find(pred)
          if (m) return m
          await sleep(20)
        }
        throw new Error(`timed out; got ${got.map((m) => m.t).join(', ')}`)
      },
      close: () => ws.close(),
    }))
    ws.on('error', reject)
  })
}

try {
  await waitUp()
  const c = await client()
  const bytes = Buffer.from('%PDF-1.4 not really a pdf\n')

  await test('a file sent as bytes is kept in the data folder and its path comes back', async () => {
    c.send({ t: 'file_put', id: 'f1', name: 'Quarterly report.pdf', data: bytes.toString('base64') })
    const r = await c.next((m) => m.t === 'file_put' && m.id === 'f1')
    ok(r.path && !r.error, JSON.stringify(r))
    ok(isAbsolute(r.path) && !relative(join(dir, 'attachments'), r.path).startsWith('..'), `inside attachments: ${r.path}`)
    ok(basename(r.path).endsWith('Quarterly report.pdf'), `name kept: ${r.path}`)
    ok(existsSync(r.path) && readFileSync(r.path).equals(bytes), 'same bytes on disk')
  })

  await test('a name cannot climb out of the attachments folder', async () => {
    c.send({ t: 'file_put', id: 'f2', name: '..\\..\\evil/../../x.txt', data: bytes.toString('base64') })
    const r = await c.next((m) => m.t === 'file_put' && m.id === 'f2')
    ok(r.path && !relative(join(dir, 'attachments'), r.path).startsWith('..'), `escaped: ${r.path}`)
  })

  await test('two files of the same name do not overwrite each other', async () => {
    c.send({ t: 'file_put', id: 'f3', name: 'a.txt', data: Buffer.from('one').toString('base64') })
    c.send({ t: 'file_put', id: 'f4', name: 'a.txt', data: Buffer.from('two').toString('base64') })
    const a = await c.next((m) => m.t === 'file_put' && m.id === 'f3')
    const b = await c.next((m) => m.t === 'file_put' && m.id === 'f4')
    ok(a.path !== b.path && readFileSync(a.path, 'utf8') === 'one' && readFileSync(b.path, 'utf8') === 'two', `${a.path} ${b.path}`)
  })

  await test('a file over the size limit is refused with a reason', async () => {
    c.send({ t: 'file_put', id: 'f5', name: 'big.bin', data: Buffer.alloc(26 * 1024 * 1024).toString('base64') })
    const r = await c.next((m) => m.t === 'file_put' && m.id === 'f5', 15000)
    ok(!r.path && /MB/.test(r.error ?? ''), JSON.stringify(r))
  })
  c.close()
} finally {
  link.stdin.end()
  link.kill()
}
if (failures) console.log(`\n--- link log ---\n${linkLog.slice(-2000)}`)
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
