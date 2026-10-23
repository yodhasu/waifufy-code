import { createServer, type IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { serveAsset } from './assets.ts'
import type { ClientMsg, ServerMsg } from './protocol.ts'
import { Session } from './session.ts'
import { listSessions, loadHistory, loadSettings, shortPath } from './store.ts'

// The Tauri app starts this process with a free port and a token, and closes stdin when it quits.
const PORT = Number(process.env.WC_PORT ?? 47900)
const TOKEN = process.env.WC_TOKEN ?? ''

const http = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://link')
  if (pathname === '/health') return res.end('ok')
  // Model files and voices are served without the token: the page loads them by URL.
  if (pathname === '/config' || pathname.startsWith('/assets/')) return void serveAsset(pathname, res)
  res.writeHead(404).end()
})

const wss = new WebSocketServer({
  server: http,
  verifyClient: ({ req }: { req: IncomingMessage }) => new URL(req.url ?? '/', 'http://link').searchParams.get('token') === TOKEN,
})

let session: Session | undefined

function broadcast(m: ServerMsg) {
  const data = JSON.stringify(m)
  for (const ws of wss.clients) ws.send(data)
}

function send(ws: WebSocket, m: ServerMsg) {
  ws.send(JSON.stringify(m))
}

async function handle(ws: WebSocket, m: ClientMsg) {
  switch (m.t) {
    case 'sessions':
      return send(ws, { t: 'sessions', list: await listSessions() })
    case 'start': {
      session?.close()
      const settings = await loadSettings()
      const history = m.resume ? await loadHistory(m.resume, m.cwd) : []
      session = new Session(m.cwd, m.resume, settings.userName, broadcast)
      return broadcast({ t: 'started', cwd: m.cwd, cwdShort: shortPath(m.cwd), userName: settings.userName, history })
    }
    case 'say':
      return session?.say(m.text)
    case 'interrupt':
      return session?.interrupt()
    case 'end':
      session?.close()
      session = undefined
      return
    case 'mode':
      return session?.setMode(m.mode)
    case 'model':
      return session?.setModel(m.model)
    case 'permission':
      return session?.answerPermission(m.id, m.decision, m.message)
    case 'answer':
      return session?.answerQuestion(m.id, m.answers)
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m: ClientMsg
    try {
      m = JSON.parse(String(raw))
    } catch {
      return
    }
    handle(ws, m).catch((e) => send(ws, { t: 'error', message: e instanceof Error ? e.message : String(e) }))
  })
})

function shutdown() {
  session?.close()
  process.exit(0)
}
// stdin closes when the app exits (or crashes), so the sidecar never outlives it.
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

http.listen(PORT, '127.0.0.1', () => console.log(`[link] listening on 127.0.0.1:${PORT}`))
