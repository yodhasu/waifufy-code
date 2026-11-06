// Test fixture: starts fine, counts starts in its data folder, then dies.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
appendFileSync(join(process.env.WC_MOD_DATA, 'starts.txt'), 'x')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: true }) + '\n')
  setTimeout(() => process.exit(1), 20)
})
