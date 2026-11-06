// Unit check of link/src/tickets.ts pluginDir(): where the Tickets card looks for the waifufy-tickets plugin.
// Run: node tests/unit/tickets.test.mjs   (no app, no Claude).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const T = await import('../../link/src/tickets.ts')

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

/** A fake Claude config dir whose installed_plugins.json lists `entries` for waifufy-tickets@waifufy. */
function claudeDir(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-tickets-claude-'))
  mkdirSync(join(dir, 'plugins'))
  if (entries !== undefined) {
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'waifufy-tickets@waifufy': entries } }))
  }
  return dir
}
/** A plugin folder with a store (or without one when `store` is false). */
function plugin(store = true) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-tickets-plugin-'))
  mkdirSync(join(dir, 'src'))
  if (store) writeFileSync(join(dir, 'src', 'store.mjs'), 'export class TicketStore {}\n')
  return dir
}
function withEnv(env, fn) {
  const saved = { WC_TICKETS_PLUGIN: process.env.WC_TICKETS_PLUGIN, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}
const repoDefault = (dir) => dir.replace(/\\/g, '/').endsWith('/plugins/waifufy-tickets')

test('WC_TICKETS_PLUGIN wins over an installed copy', () => {
  const installed = plugin()
  withEnv({ WC_TICKETS_PLUGIN: 'X:/elsewhere', CLAUDE_CONFIG_DIR: claudeDir([{ installPath: installed }]) }, () =>
    eq(T.pluginDir(), 'X:/elsewhere', 'env'),
  )
})

test('the copy Claude Code installed is used (the installed app has no repo)', () => {
  const installed = plugin()
  withEnv({ WC_TICKETS_PLUGIN: undefined, CLAUDE_CONFIG_DIR: claudeDir([{ installPath: installed }]) }, () =>
    eq(T.pluginDir(), installed, 'installPath'),
  )
})

test('the newest install with a store wins', () => {
  const old = plugin()
  const fresh = plugin()
  const broken = plugin(false)
  const entries = [
    { installPath: old, lastUpdated: '2026-11-01T00:00:00Z' },
    { installPath: broken, lastUpdated: '2026-11-06T00:00:00Z' },
    { installPath: fresh, lastUpdated: '2026-11-05T00:00:00Z' },
  ]
  withEnv({ WC_TICKETS_PLUGIN: undefined, CLAUDE_CONFIG_DIR: claudeDir(entries) }, () => eq(T.pluginDir(), fresh, 'newest with store'))
})

test('no install record falls back to the repo folder', () => {
  withEnv({ WC_TICKETS_PLUGIN: undefined, CLAUDE_CONFIG_DIR: claudeDir(undefined) }, () => eq(repoDefault(T.pluginDir()), true, 'repo'))
})

test('a malformed install record falls back to the repo folder', () => {
  withEnv({ WC_TICKETS_PLUGIN: undefined, CLAUDE_CONFIG_DIR: claudeDir('not-an-array') }, () => eq(repoDefault(T.pluginDir()), true, 'repo'))
})

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
