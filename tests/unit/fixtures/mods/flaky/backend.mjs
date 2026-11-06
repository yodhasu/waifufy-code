// Test fixture: first start answers init then dies; every later start hangs in init.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const f = join(process.env.WC_MOD_DATA, 'starts.txt')
appendFileSync(f, 'x')
const first = readFileSync(f, 'utf8').length === 1
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!first) return
  const m = JSON.parse(line)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: true }) + String.fromCharCode(10))
  setTimeout(() => process.exit(1), 20)
})
