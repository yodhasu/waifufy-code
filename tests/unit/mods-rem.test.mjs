// The REM mod (plugins/rem) end to end against a real link in mock mode: its backend starts a session in the
// configured folder with the night brief as the first message, then forwards a REM ticket filed later (and not
// one without the rem label) into that session.
// Run: node tests/unit/mods-rem.test.mjs (no app, no Claude). Needs port 47996 free.
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TicketStore } from '../../plugins/waifufy-tickets/src/store.mjs'

const root = new URL('../..', import.meta.url)
const require = createRequire(new URL('../../link/package.json', import.meta.url))
const { WebSocket } = require('ws')

const dir = mkdtempSync(join(tmpdir(), 'wc-mods-rem-'))
const project = join(dir, 'project')
mkdirSync(project)
const appdata = join(dir, 'appdata')
mkdirSync(join(appdata, 'waifufy-tickets'), { recursive: true })
const db = join(appdata, 'waifufy-tickets', 'kanban.db')

// The real mod, with times that make "now" always inside the night and a brief inside the mod folder.
const modsDir = join(dir, 'mods')
const remDir = join(modsDir, 'rem')
cpSync(new URL('../../plugins/rem', import.meta.url), remDir, { recursive: true })
writeFileSync(join(remDir, 'brief.md'), 'REM night run test brief, {{loops}} rounds, stop at {{last_commit}}.')
const manifest = JSON.parse(readFileSync(join(remDir, 'mod.json'), 'utf8'))
const defaults = { cwd: project, brief: join(remDir, 'brief.md'), start: '00:00', wrapUp: '23:59', stop: '23:59' }
for (const f of manifest.settings) if (f.key in defaults) f.default = defaults[f.key]
writeFileSync(join(remDir, 'mod.json'), JSON.stringify(manifest))

const store = new TicketStore(db)
store.create({ title: 'waiting before the night', project: 'covena', labels: ['rem', 'adipura'] })

const PORT = 47996
const TOKEN = 'desktop-token'
const env = {
  ...process.env, APPDATA: appdata, WC_PORT: String(PORT), WC_TOKEN: TOKEN, WC_DATA_DIR: dir, WC_REMOTE_PORT: '47936', WC_MOCK: '1',
  WC_MOCK_TICK_MS: '2', WC_TRUST_FOLDERS: project, WC_MODS_DIR: modsDir, WC_REM_TICK_MS: '300',
}
delete env.WC_CASUAL_KEY
const link = spawn(process.execPath, ['link/src/server.ts'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
let linkLog = ''
link.stdout.on('data', (d) => (linkLog += d))
link.stderr.on('data', (d) => (linkLog += d))

let failures = 0
const ok = (v, msg) => {
  if (!v) throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
        const got = []
        ws.on('message', (raw) => got.push(JSON.parse(String(raw))))
        ws.on('open', () => resolve({ got, ws }))
        ws.on('error', reject)
      })
    } catch {
      await sleep(100)
    }
  }
  throw new Error('link never came up')
}

async function until(got, pred, what, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const m = got.find(pred)
    if (m) return m
  }
  throw new Error(`timed out waiting for ${what}; got: ${got.map((x) => x.t).join(', ')}`)
}

try {
  const { got, ws } = await connect()
  ws.send(JSON.stringify({ t: 'hello' }))

  const started = await until(got, (m) => m.t === 'session_started', 'session_started')
  ok(started.cwd === project, `cwd: ${started.cwd}`)
  const brief = await until(got, (m) => m.t === 'said' && m.text?.startsWith('REM night run'), 'the brief')
  ok(brief.text.includes('3 rounds') && brief.text.includes('23:59'), `placeholders filled: ${brief.text}`)
  console.log('PASS  starts a session in the configured folder with the brief')

  ok(!got.some((m) => m.t === 'said' && m.text?.includes('waiting before the night')), 'a ticket waiting at start is not forwarded again')
  store.create({ title: 'not ours', project: 'covena', labels: ['adipura'] })
  store.create({ title: 'filed during the night', project: 'covena', labels: ['rem', 'smmotorsport'] })
  await until(got, (m) => m.t === 'said' && m.text?.includes('filed during the night'), 'the forwarded ticket')
  await sleep(1000)
  ok(!got.some((m) => m.t === 'said' && m.text?.includes('not ours')), 'a ticket without the rem label is not forwarded')
  ok(got.filter((m) => m.t === 'session_started').length === 1, 'the session starts once per night')
  console.log('PASS  forwards a new rem ticket once, ignores others')
  ws.close()
} catch (e) {
  failures++
  console.log(`FAIL  ${e.stack ?? e.message}\n--- link log ---\n${linkLog.slice(-3000)}`)
} finally {
  link.kill()
  store.close?.()
}
process.exit(failures ? 1 : 0)
