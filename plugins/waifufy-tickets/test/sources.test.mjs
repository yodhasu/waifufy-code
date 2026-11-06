// Guards for the files nothing else executes: every .mjs must parse, and every command must carry the
// frontmatter Claude Code needs. install.mjs shipped with a syntax error once because no test ran it.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return path
  })
}

describe('sources', () => {
  it('every module parses', () => {
    const files = [
      ...walk(join(ROOT, 'src')),
      ...walk(join(ROOT, 'bin')),
      ...walk(join(ROOT, 'test')),
      join(ROOT, 'install.mjs'),
    ].filter((f) => f.endsWith('.mjs'))

    assert.ok(files.length >= 6, `expected the plugin's modules, found ${files.length}`)
    for (const file of files) {
      // `node --check` uses the same parser the sidecar's runtime does, so a syntax slip cannot hide.
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    }
  })

  it('every command has a description and a usage hint', () => {
    const dir = join(ROOT, 'commands')
    const commands = readdirSync(dir).filter((f) => f.endsWith('.md'))
    assert.deepEqual(commands.sort(), ['add.md', 'board.md', 'move.md', 'show.md', 'triage.md'])

    for (const name of commands) {
      const text = readFileSync(join(dir, name), 'utf8')
      assert.match(text, /^---\n/, `${name} needs frontmatter`)
      const front = text.slice(4, text.indexOf('\n---', 4))
      assert.match(front, /^description: .{20,}/m, `${name} needs a real description`)
      assert.match(front, /^argument-hint: /m, `${name} needs an argument-hint`)
      // The body is the prompt the agent runs, so it has to be more than the frontmatter.
      assert.ok(text.length - front.length > 120, `${name} looks empty`)
      if (name === 'triage.md') {
        // The filter is the whole point of v0: a thin prompt here would quietly become a bad filter.
        assert.ok(text.length - front.length > 800, 'triage.md must carry the full filter rules')
      }
    }
  })

  it('the manifests agree with the folder', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
    const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'))

    assert.equal(plugin.name, 'waifufy-tickets')
    assert.equal(plugin.version, pkg.version, 'plugin.json and package.json must not drift')
    assert.ok(market.plugins.some((p) => p.name === plugin.name), 'the marketplace must list the plugin')
    assert.ok(mcp.mcpServers.tickets, '.mcp.json must register the tickets server')
    assert.match(mcp.mcpServers.tickets.args.join(' '), /\$\{CLAUDE_PLUGIN_ROOT\}/, 'the server path must resolve inside the installed plugin')
    // The arg is a template, not a path yet: expand it and prove the file it names is really here.
    const serverArg = mcp.mcpServers.tickets.args.at(-1)
    const serverPath = join(ROOT, serverArg.replace('${CLAUDE_PLUGIN_ROOT}', ''))
    assert.equal(existsSync(serverPath), true, `${serverArg} must name a file in the plugin`)
  })
})
