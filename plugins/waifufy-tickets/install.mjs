#!/usr/bin/env node
// One-command install for the waifufy-tickets plugin. Nothing is compiled and nothing is
// bundled into the Waifufy app: this registers the folder as a local plugin marketplace
// and installs the plugin from it, so the plugin can be removed again in two commands.
//
//   node install.mjs              add marketplace + install (then DISABLE it: default off)
//   node install.mjs --enable     ... and leave it enabled for every project
//   node install.mjs --off        disable an existing install without reinstalling
//   node install.mjs --status     show what is registered right now
//   node install.mjs --json       machine-readable result of the run
//   node install.mjs --uninstall  uninstall the plugin and remove the marketplace
//   node install.mjs --dry-run    print the commands without running them
//
// `claude plugin install` turns a plugin on, and this one costs its tool schemas in every session,
// so a fresh install is turned back off unless --enable asked for it.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const MARKETPLACE = 'waifufy'
const PLUGIN = 'waifufy-tickets'
const FULL = `${PLUGIN}@${MARKETPLACE}`

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const dryRun = flag('dry-run')
const json = flag('json')

function log(...args) {
  if (!json) process.stdout.write(`${args.join(' ')}\n`)
}

function claude(args, { quiet = false } = {}) {
  const options = { encoding: 'utf8', windowsHide: true }
  let result = spawnSync('claude', args, options)
  // On Windows `claude` is a .cmd shim: Node refuses to spawn those without a shell (EINVAL, not
  // ENOENT), so retry through the shell. Args are quoted for it; none of ours hold shell metacharacters.
  if (result.error && process.platform === 'win32' && ['ENOENT', 'EINVAL'].includes(result.error.code)) {
    const quoted = args.map((a) => (a.includes(' ') ? `"${a}"` : a))
    result = spawnSync('claude', quoted, { ...options, shell: true })
  }
  if (result.error) {
    return { ok: false, out: '', err: String(result.error.message) }
  }
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (!quiet && out.trim()) process.stderr.write(`${out.trim()}\n`)
  return { ok: result.status === 0, out, err: result.stderr ?? '', status: result.status }
}

/** Run, or print when --dry-run. */
function step(label, args) {
  log(`\n> ${label}`)
  log(`  claude ${args.join(' ')}`)
  if (dryRun) return { ok: true, out: '', dryRun: true }
  return claude(args)
}

function status() {
  const list = claude(['plugin', 'list'], { quiet: true })
  const marketplaces = claude(['plugin', 'marketplace', 'list'], { quiet: true })
  return {
    marketplaceAdded: /waifufy/.test(marketplaces.out),
    ...readState(list.out),
    dbPath: process.env.WC_TICKETS_DB ?? defaultDbHint(),
  }
}

/** `plugin list` prints one block per plugin: "> id", "Version:", "Read from:", "Scope:", "Status: √ enabled". */
function readState(listOut) {
  const at = listOut.indexOf(`${PLUGIN}@${MARKETPLACE}`)
  if (at === -1) return { installed: false, enabled: false }
  const block = listOut.slice(at, at + 400)
  return { installed: true, enabled: /disabled/.test(block) ? false : /enabled/.test(block) ? true : undefined }
}

function defaultDbHint() {
  const base = process.env.APPDATA || join(process.env.HOME ?? '', '.config')
  return join(base, 'waifufy-tickets', 'kanban.db')
}

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  const ok = major > 22 || (major === 22 && minor >= 5)
  if (!ok) {
    process.stderr.write(
      `node ${process.versions.node} is too old: the store uses node:sqlite (Node >= 22.5, 24 recommended)\n`,
    )
  }
  return ok
}

function main() {
  if (flag('help') || flag('-h')) {
    process.stdout.write(`usage: node install.mjs [--enable|--off] [--status] [--uninstall] [--dry-run] [--json]\n`)
    return 0
  }
  if (!existsSync(join(ROOT, '.claude-plugin', 'plugin.json'))) {
    process.stderr.write(`not a plugin folder: ${ROOT}\n`)
    return 1
  }

  if (flag('status')) {
    const row = status()
    if (json) process.stdout.write(`${JSON.stringify(row, null, 2)}\n`)
    else {
      log(`marketplace ${MARKETPLACE}: ${row.marketplaceAdded ? 'added' : 'not added'}`)
      log(`plugin ${FULL}: ${row.installed ? (row.enabled ? 'installed, enabled' : 'installed, disabled') : 'not installed'}`)
      log(`database: ${row.dbPath}`)
    }
    return 0
  }

  if (flag('uninstall')) {
    step(`uninstall ${FULL}`, ['plugin', 'uninstall', FULL])
    step(`remove marketplace ${MARKETPLACE}`, ['plugin', 'marketplace', 'remove', MARKETPLACE])
    log('\nThe board data is left in place; delete the database file to remove it too.')
    return 0
  }

  const nodeOk = checkNode()
  const before = dryRun ? { marketplaceAdded: false, installed: false } : status()

  if (before.marketplaceAdded) {
    log(`marketplace ${MARKETPLACE} is already added`)
  } else {
    const added = step(`add marketplace`, ['plugin', 'marketplace', 'add', ROOT])
    if (!added.ok && !/already/i.test(added.out ?? '')) {
      process.stderr.write(`\nfailed to add the marketplace. Manual fallback:\n  /plugin marketplace add ${ROOT}\n`)
      return 1
    }
  }

  if (before.installed) {
    log(`plugin ${FULL} is already installed`)
  } else {
    const installed = step(`install ${PLUGIN}`, ['plugin', 'install', FULL])
    if (!installed.ok) {
      process.stderr.write(`\nfailed to install. Manual fallback:\n  /plugin install ${FULL}\n`)
      return 1
    }
  }

  if (flag('enable')) {
    step(`enable ${FULL}`, ['plugin', 'enable', FULL])
  } else if (flag('off') || !before.installed) {
    step(`disable ${FULL} (default off)`, ['plugin', 'disable', FULL])
  }

  const after = dryRun ? { marketplaceAdded: true, installed: true, enabled: flag('enable') } : status()
  const result = {
    ok: nodeOk && after.marketplaceAdded && after.installed,
    node: process.versions.node,
    plugin: FULL,
    marketplaceAdded: after.marketplaceAdded,
    installed: after.installed,
    enabled: after.enabled,
    dbPath: after.dbPath,
    root: ROOT,
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    log('\n---')
    log(`plugin   ${FULL}`)
    log(`status   ${after.installed ? (after.enabled ? 'enabled' : 'installed, DISABLED') : 'unknown'}`)
    log(`database ${after.dbPath}`)
    log(`folder   ${ROOT}`)
    log('')
    log(after.enabled ? 'Ready: /waifufy-tickets:board, /waifufy-tickets:triage, /waifufy-tickets:add, /waifufy-tickets:move, /waifufy-tickets:show' : `Enable it when you want it (it costs ~100 tokens in every session):\n  claude plugin enable ${FULL}\n  (or run this script again with --enable)`)
    log(`Turn it off again with:\n  claude plugin disable ${FULL}`)
    log(`Remove everything with:\n  node install.mjs --uninstall`)
    log("\nRestart Claude Code (or start a new session) so the plugin's commands and MCP tools load.")
  }
  return result.ok ? 0 : 1
}

process.exitCode = main()
