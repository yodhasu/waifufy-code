// Test fixture: opens node:sqlite on a db in its data folder (the fs.write path) and returns a row.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const db = new DatabaseSync(join(process.env.WC_MOD_DATA, 't.db'))
db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT); INSERT INTO t VALUES (\'hi\')')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'init' ? true : db.prepare('SELECT v FROM t').all() }) + '\n')
})
