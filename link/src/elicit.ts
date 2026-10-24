import type { ElicitField, ElicitValue } from './protocol.ts'

// MCP elicitation forms: the server's requested JSON schema (a flat object of primitive properties, per the MCP
// spec) as the fields the app draws, and the user's answers checked back against it before they are sent.

type Prop = {
  type?: string
  title?: string
  description?: string
  enum?: unknown[]
  enumNames?: unknown[]
  oneOf?: { const?: unknown; title?: unknown }[]
  items?: { enum?: unknown[]; anyOf?: { const?: unknown; title?: unknown }[] }
  default?: unknown
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

function options(p: Prop): ElicitField['options'] {
  if (p.oneOf?.length) return p.oneOf.map((o) => ({ value: str(o.const), label: str(o.title) || str(o.const) }))
  if (p.enum?.length) return p.enum.map((v, i) => ({ value: str(v), label: str(p.enumNames?.[i]) || str(v) }))
  const items = p.items?.anyOf ?? p.items?.enum?.map((v) => ({ const: v, title: v }))
  return items?.map((o) => ({ value: str(o.const), label: str(o.title) || str(o.const) }))
}

/** The form's fields, in the schema's property order. */
export function elicitFields(schema: Record<string, unknown> | undefined): ElicitField[] {
  const props = (schema?.properties ?? {}) as Record<string, Prop>
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : [])
  return Object.entries(props).map(([name, p]) => {
    const opts = options(p)
    const kind: ElicitField['kind'] =
      p.type === 'array' ? 'multi'
      : opts?.length ? 'choice'
      : p.type === 'boolean' ? 'boolean'
      : p.type === 'integer' ? 'integer'
      : p.type === 'number' ? 'number'
      : 'text'
    const def = p.default
    return {
      name,
      title: p.title || name,
      ...(p.description ? { description: p.description } : {}),
      kind,
      required: required.has(name),
      ...(opts?.length ? { options: opts } : {}),
      ...(def !== undefined && (typeof def !== 'object' || Array.isArray(def)) ? { default: def as ElicitValue } : {}),
      ...(p.format ? { format: p.format } : {}),
      ...(kind === 'text' ? { min: p.minLength, max: p.maxLength } : { min: p.minimum, max: p.maximum }),
    }
  })
}

/** Checks and converts the app's answers to the schema's types; throws a message naming the first bad field. */
export function elicitContent(fields: ElicitField[], raw: Record<string, unknown>): Record<string, ElicitValue> {
  const out: Record<string, ElicitValue> = {}
  for (const f of fields) {
    const v = raw[f.name]
    const empty = v === undefined || v === '' || (Array.isArray(v) && !v.length)
    if (empty) {
      if (f.required && f.kind !== 'boolean') throw new Error(`${f.title} is required`)
      if (f.kind === 'boolean') out[f.name] = false
      continue
    }
    if (f.kind === 'boolean') out[f.name] = v === true || v === 'true'
    else if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(v)
      if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) throw new Error(`${f.title} must be ${f.kind === 'integer' ? 'a whole number' : 'a number'}`)
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) throw new Error(`${f.title} must be between ${f.min ?? '−∞'} and ${f.max ?? '∞'}`)
      out[f.name] = n
    } else if (f.kind === 'multi') out[f.name] = (Array.isArray(v) ? v : [v]).map(str)
    else {
      const s = str(v)
      if (f.kind === 'choice' && f.options && !f.options.some((o) => o.value === s)) throw new Error(`${f.title}: pick one of the options`)
      if (f.min !== undefined && s.length < f.min) throw new Error(`${f.title} must be at least ${f.min} characters`)
      if (f.max !== undefined && s.length > f.max) throw new Error(`${f.title} must be at most ${f.max} characters`)
      out[f.name] = s
    }
  }
  return out
}
