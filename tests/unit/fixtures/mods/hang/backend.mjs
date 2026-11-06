// Test fixture: answers init, then never answers anything (not even shutdown).
import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'init') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: true }) + '\n')
})
