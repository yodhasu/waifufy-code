// Unit check of link/src/mods/claude-adapter.ts: the MCP server of mod tools and the skills plugin folder.
// Run: node tests/unit/mods-adapter.test.mjs   (no app, no Claude; Mods is a stub with the three methods the adapter uses).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WC_DATA_DIR = mkdtempSync(join(tmpdir(), 'wc-adapter-data-'))
const { MODS_SERVER, callModTool, modToolNames, modsMcpServer, modsSignature, writeSkillsPlugin } = await import('../../link/src/mods/claude-adapter.ts')

const root = mkdtempSync(join(tmpdir(), 'wc-adapter-'))
const skill = (mod, name) => {
  const dir = join(root, mod, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\nhi`)
  return dir
}
const T = (name) => ({ name, description: `the ${name} tool`, input: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } })
let tools = [{ id: 'a', tool: T('one') }, { id: 'b', tool: T('two') }]
let skills = [{ id: 'a', name: 'tidy', dir: skill('a', 'tidy') }, { id: 'b', name: 'lint', dir: skill('b', 'lint') }]
const calls = []
const mods = {
  enabledTools: () => tools,
  enabledSkills: () => skills,
  toolCall: async (id, name, input) => (calls.push([id, name, input]), name === 'bad' ? Promise.reject(new Error('backend said no')) : { ok: input }),
}

const tests = [
  ['two mods with tools: one server listing both', async () => {
    const s = modsMcpServer(mods)
    assert.equal(s.name, MODS_SERVER)
    assert.deepEqual(Object.keys(s.instance._registeredTools).sort(), ['one', 'two'])
    assert.deepEqual(modToolNames(mods), ['mcp__waifufy-mods__one', 'mcp__waifufy-mods__two'])
  }],
  ['modsSignature changes with the tools or skills, not with anything else', async () => {
    const before = modsSignature(mods)
    assert.equal(modsSignature({ ...mods }), before)
    tools = [...tools, { id: 'c', tool: T('three') }]
    assert.notEqual(modsSignature(mods), before)
    tools = [{ id: 'a', tool: T('one') }, { id: 'b', tool: T('two') }]
    assert.equal(modsSignature(mods), before)
    skills = [...skills, { id: 'c', name: 'new', dir: skills[0].dir }]
    assert.notEqual(modsSignature(mods), before)
    skills = skills.slice(0, 2)
  }],
  ['name clash keeps first, logs second', async () => {
    tools = [{ id: 'a', tool: T('dup') }, { id: 'b', tool: T('dup') }]
    const logged = []
    const warn = console.warn
    console.warn = (m) => logged.push(m)
    const names = modToolNames(mods)
    console.warn = warn
    assert.deepEqual(names, ['mcp__waifufy-mods__dup'])
    assert.equal(logged.length, 1)
    assert.match(logged[0], /"b".*"a"/)
  }],
  ['tool result is text; a rejection is an error result, not a throw', async () => {
    const ok = await callModTool(mods, 'a', 'one', { q: 'x' })
    assert.deepEqual(ok, { content: [{ type: 'text', text: '{"ok":{"q":"x"}}' }] })
    const bad = await callModTool(mods, 'a', 'bad', {})
    assert.equal(bad.isError, true)
    assert.equal(bad.content[0].text, 'backend said no')
  }],
  ['skills folder lists only enabled mods and removes a disabled mod folder', async () => {
    const out = join(root, 'plugin')
    assert.equal(writeSkillsPlugin(mods, out), out)
    assert.deepEqual(readdirSync(join(out, 'skills')).sort(), ['a-tidy', 'b-lint'])
    assert.ok(existsSync(join(out, 'skills', 'a-tidy', 'SKILL.md')))
    skills = skills.filter((s) => s.id === 'a')
    writeSkillsPlugin(mods, out)
    assert.deepEqual(readdirSync(join(out, 'skills')), ['a-tidy'])
  }],
  ['generated plugin.json is valid JSON with name waifufy-mods', async () => {
    const j = JSON.parse(readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'))
    assert.deepEqual(j, { name: 'waifufy-mods', version: '1.0.0' })
  }],
]

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}\n  ${e.stack}`)
  }
}
process.exit(failed ? 1 : 0)
