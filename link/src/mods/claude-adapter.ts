// The Claude Code side of the mods: an in-process MCP server with every enabled mod's tools, and a local plugin
// folder holding their skills. session.ts hands both to the SDK; mod.json stays the only thing a mod author writes.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { DATA_DIR } from '../settings.ts'
import type { Mods } from './index.ts'

export const MODS_SERVER = 'waifufy-mods'

/** Enabled tools by name; a name already taken keeps the first mod's tool and logs the later one. */
function uniqueTools(mods: Mods) {
  const seen = new Map<string, string>()
  return mods.enabledTools().filter(({ id, tool: t }) => {
    const first = seen.get(t.name)
    if (first !== undefined) console.warn(`[mods] tool "${t.name}" of "${id}" clashes with the one from "${first}"; keeping the first`)
    else seen.set(t.name, id)
    return first === undefined
  })
}

/** Runs a mod's tool as MCP text content; a failure comes back as an error result, never as a throw. */
export async function callModTool(mods: Mods, id: string, name: string, input: unknown): Promise<CallToolResult> {
  try {
    const out = await mods.toolCall(id, name, input)
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : (JSON.stringify(out) ?? 'null') }] }
  } catch (e) {
    return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }
  }
}

/** The MCP shape of a mod's JSON Schema; an unusable schema degrades to "no arguments" rather than hiding the tool. */
function shapeOf(id: string, name: string, schema: Record<string, unknown>) {
  try {
    const s = z.fromJSONSchema(schema as never)
    if (s instanceof z.ZodObject) return s.shape
  } catch (e) {
    console.warn(`[mods] tool "${name}" of "${id}": input schema not usable (${e instanceof Error ? e.message : e})`)
  }
  return {}
}

/** One SDK MCP server listing the enabled mods' tools. */
export function modsMcpServer(mods: Mods) {
  return createSdkMcpServer({
    name: MODS_SERVER,
    tools: uniqueTools(mods).map(({ id, tool: t }) => tool(t.name, t.description, shapeOf(id, t.name, t.input), (input) => callModTool(mods, id, t.name, input))),
  })
}

/** The names `allowedTools` needs for them. */
export const modToolNames = (mods: Mods): string[] => uniqueTools(mods).map(({ tool: t }) => `mcp__${MODS_SERVER}__${t.name}`)

/** Writes the plugin folder (manifest + one skill folder per enabled mod skill, stale ones removed); returns it. */
export function writeSkillsPlugin(mods: Mods, outDir = join(DATA_DIR, 'adapters', 'claude', MODS_SERVER)): string {
  mkdirSync(join(outDir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: MODS_SERVER, version: '1.0.0' }))
  const skills = join(outDir, 'skills')
  mkdirSync(skills, { recursive: true })
  const want = new Map(mods.enabledSkills().map((s) => [`${s.id}-${s.name}`, s.dir]))
  for (const d of readdirSync(skills)) if (!want.has(d)) rmSync(join(skills, d), { recursive: true, force: true })
  for (const [name, dir] of want) {
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    rmSync(join(skills, name), { recursive: true, force: true })
    cpSync(dir, join(skills, name), { recursive: true })
  }
  return outDir
}
