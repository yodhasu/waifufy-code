// Test fixture: prints junk and an oversize line before every answer.
import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  process.stdout.write('hello, I am not json\n' + 'x'.repeat(1_100_000) + '\n')
  process.stderr.write('some stderr\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.params ?? true }) + '\n')
})
