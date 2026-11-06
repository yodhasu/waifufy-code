// E2E fixture backend: answers init, then dies, every time it is started.
import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: true }) + '\n')
  setTimeout(() => process.exit(1), 20)
})
