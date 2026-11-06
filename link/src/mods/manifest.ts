// A mod's mod.json, parsed and checked. Everything in a manifest is untrusted JSON from a folder the user
// dropped in, so each field is validated here and a bad mod comes back as a status the Mods page can show
// instead of an exception. Paths must stay inside the mod folder and point at files that exist.

import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { SettingField } from '../protocol.ts'

/** Manifest API versions this app can run. Anything else is reported as `incompatible`. */
export const SUPPORTED_API_VERSIONS = [1]

export type { SettingField }
export type ToolDef = { name: string; description: string; input: Record<string, unknown> }
export type ModManifest = {
  id: string
  name: string
  version: string
  apiVersion: 1
  description: string
  defaultEnabled: boolean
  panel?: { entry: string; slot: 'chat.left' | 'chat.right' }
  settingsPage?: string
  backend?: { entry: string }
  tools: ToolDef[]
  skills: string[]
  settings: SettingField[]
  permissions: string[]
}
export type ParseResult = { ok: true; manifest: ModManifest } | { ok: false; status: 'invalid' | 'incompatible'; reason: string }

const FIELD_TYPES = ['string', 'number', 'boolean', 'select', 'secret']
const SLOTS = ['chat.left', 'chat.right']

/** Thrown inside parseManifest for the first problem found; caught there and returned as a result. */
class Bad extends Error {
  status: 'invalid' | 'incompatible'
  constructor(reason: string, status: 'invalid' | 'incompatible' = 'invalid') {
    super(reason)
    this.status = status
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''

function needStr(v: unknown, what: string): string {
  if (!isStr(v)) throw new Bad(`${what} must be a non-empty string`)
  return v
}
function needList(v: unknown, what: string): unknown[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new Bad(`${what} must be an array`)
  return v
}

/** `rel` resolved under `dir`; throws if it leaves the folder or (when `file`) is not an existing file. */
function inside(dir: string, rel: unknown, what: string, file = true): string {
  const root = resolve(dir)
  const p = resolve(root, needStr(rel, what))
  if (!p.startsWith(root + sep)) throw new Bad('path escapes the mod folder')
  if (file && !(existsSync(p) && statSync(p).isFile())) throw new Bad(`${what} file not found: ${rel}`)
  return p
}

function parseField(f: unknown): SettingField {
  if (!isObj(f)) throw new Bad('settings entries must be objects')
  const key = needStr(f.key, 'setting key')
  if (!FIELD_TYPES.includes(f.type as string)) throw new Bad(`setting "${key}" has an unknown type`)
  const field: SettingField = { key, type: f.type as SettingField['type'], label: needStr(f.label, `setting "${key}" label`) }
  if ('default' in f) field.default = f.default
  if (field.type === 'select') {
    const opts = needList(f.options, `setting "${key}" options`)
    if (!opts.length || !opts.every(isStr)) throw new Bad(`select setting "${key}" needs a non-empty options list of strings`)
    field.options = opts as string[]
  }
  return field
}

function parseTool(t: unknown): ToolDef {
  if (!isObj(t)) throw new Bad('tools entries must be objects')
  const name = needStr(t.name, 'tool name')
  if (!isObj(t.input)) throw new Bad(`tool "${name}" input must be a JSON schema object`)
  return { name, description: needStr(t.description, `tool "${name}" description`), input: t.input }
}

/** Validate `raw` (the parsed mod.json) for the mod folder `dir`. Never throws. */
export function parseManifest(raw: unknown, dir: string): ParseResult {
  try {
    if (!isObj(raw)) throw new Bad('mod.json must be an object')
    if (!SUPPORTED_API_VERSIONS.includes(raw.apiVersion as number)) throw new Bad(`apiVersion ${JSON.stringify(raw.apiVersion)} is not supported`, 'incompatible')
    const id = needStr(raw.id, 'id')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Bad('id must be lowercase letters, digits and dashes')
    const m: ModManifest = {
      id,
      name: needStr(raw.name, 'name'),
      version: needStr(raw.version, 'version'),
      apiVersion: 1,
      description: typeof raw.description === 'string' ? raw.description : '',
      defaultEnabled: raw.defaultEnabled === true,
      tools: needList(raw.tools, 'tools').map(parseTool),
      skills: needList(raw.skills, 'skills').map((s) => {
        // A skill name is a folder name, never a path.
        if (!isStr(s) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) throw new Bad('skills entries must be plain folder names')
        inside(dir, `skills/${s}/SKILL.md`, `skill "${s}"`)
        return s
      }),
      settings: needList(raw.settings, 'settings').map(parseField),
      permissions: needList(raw.permissions, 'permissions').map((p) => needStr(p, 'permissions entry')),
    }
    if (new Set(m.tools.map((t) => t.name)).size !== m.tools.length) throw new Bad('duplicate tool names')
    if (new Set(m.settings.map((s) => s.key)).size !== m.settings.length) throw new Bad('duplicate setting keys')
    if (raw.panel !== undefined) {
      if (!isObj(raw.panel) || !SLOTS.includes(raw.panel.slot as string)) throw new Bad('panel.slot must be chat.left or chat.right')
      inside(dir, raw.panel.entry, 'panel.entry')
      m.panel = { entry: raw.panel.entry as string, slot: raw.panel.slot as 'chat.left' | 'chat.right' }
    }
    if (raw.settingsPage !== undefined) {
      inside(dir, raw.settingsPage, 'settingsPage')
      m.settingsPage = raw.settingsPage as string
    }
    if (raw.backend !== undefined) {
      if (!isObj(raw.backend)) throw new Bad('backend must be an object')
      inside(dir, raw.backend.entry, 'backend.entry')
      m.backend = { entry: raw.backend.entry as string }
    }
    return { ok: true, manifest: m }
  } catch (e) {
    if (e instanceof Bad) return { ok: false, status: e.status, reason: e.message }
    throw e
  }
}
