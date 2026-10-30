import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { query, type Options, type Query, type SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk'
import type { PersonaPreset, ResearchProfile } from './protocol.ts'
import { childEnv } from './shell.ts'

// Auto-research for roleplay (R40): a cheap model with web search and fetch studies the character
// and returns a structured profile plus a roleplay prompt, which the settings page previews as a preset.

export type ResearchOptions = {
  name: string
  series: string
  /** The user's own direction, e.g. "make her more tsundere" or "post-arc 4". Overrides canon. */
  notes: string
  /** The language her voice speaks (Settings → Voice): the voice notes are written for it. */
  language?: 'ja' | 'en'
  signal: AbortSignal
  onProgress(text: string): void
  /** Full path to the Claude Code executable; undefined = SDK default lookup. */
  claudePath?: string
}

/** The SDK's query(), injectable so the flow can be tested without spending model turns. */
export type QueryFn = (params: { prompt: string; options: Options }) => Query

/** The 'haiku' alias is in supportedModels() and resolves to the newest Haiku. */
const MODEL = 'haiku'
const MAX_TURNS = 14
/** Safety cap on one research run; a typical run costs a small fraction of this. */
const MAX_BUDGET_USD = 1
const WEB_TOOLS = ['WebSearch', 'WebFetch']
/** The CLI's synthetic tool that delivers `outputFormat` results. */
const OUTPUT_TOOL = 'StructuredOutput'
const SLUG_MAX = 40
const ID_RANDOM_BYTES = 3
const PROGRESS_MAX = 96
const STDERR_KEEP = 2000
const SOURCES_MAX = 20
const WRITING = 'Writing the roleplay prompt…'

const stringList = (description: string) => ({ type: 'array', items: { type: 'string' }, description })

/** Shape of the structured output. No length limits: a schema miss costs a retry turn, so counts are asked for in prose. */
export const RESEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['profile', 'prompt', 'voice', 'sources'],
  properties: {
    profile: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'personality', 'speechPatterns', 'catchphrases', 'addressing', 'relationshipCues', 'do', 'dont', 'sampleLines'],
      properties: {
        summary: { type: 'string', description: 'Two or three sentences: who the character is, which part of canon this profile follows.' },
        personality: stringList('Core traits, each a short phrase with a concrete canon example.'),
        speechPatterns: stringList('How they talk: register, verbal tics, self-reference, sentence shape.'),
        catchphrases: stringList('3-6 short signature phrases she could say to the user while working, in English (a Japanese word or two is fine). No translations, quote marks, sources or notes, and never another character name.'),
        addressing: {
          type: 'string',
          description: 'How they address others: honorifics, nicknames, shifts with closeness. The user as a pattern, never a canon name.',
        },
        relationshipCues: stringList('How they act toward someone they serve, trust or care about.'),
        do: stringList('Behaviours that keep the portrayal faithful.'),
        dont: stringList('Things they would never say or do.'),
        sampleLines: stringList('6-10 lines in work contexts, in character. No name for the user, never a canon one.'),
      },
    },
    prompt: { type: 'string', description: 'The roleplay prompt, second person, starting "You are <name>".' },
    voice: {
      type: 'object',
      additionalProperties: false,
      required: ['styleNotes', 'pronunciations'],
      properties: {
        styleNotes: stringList('5-8 notes on how she speaks aloud in the voice language: register, how she refers to herself, sentence endings, laughter and interjections, pacing.'),
        pronunciations: {
          type: 'array',
          description: 'Words a text-to-speech voice is likely to say wrong (her name and full name, the series, catchphrases, nicknames), each with a respelling it will read right.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['word', 'say'],
            properties: {
              word: { type: 'string', description: 'As written, e.g. "Pavolia Reine".' },
              say: { type: 'string', description: 'A respelling the voice reads right, e.g. "Pah-VOH-lee-ah RAY-neh" for English, katakana for Japanese.' },
            },
          },
        },
      },
    },
    sources: stringList('URLs actually used.'),
  },
} as const

const SYSTEM_PROMPT = `You are a careful character researcher for Waifufy Code, a desktop app where an AI coding assistant speaks as a fictional character while it does real software work. Your job: research one character and write the prompt that lets the assistant play them faithfully.

# Research
- Use WebSearch and WebFetch. Prefer the character's fan wiki page (Fandom and similar), official sites and interviews, and quote collections. Read at least two independent sources and cross-check them.
- Gather: personality, speech patterns (register, verbal tics, how they refer to themselves), signature lines (in the original language with a translation, for your own understanding; the catchphrases field takes short English phrases only), how they address people (honorifics, nicknames, how that shifts with closeness), relationship dynamics, emotional range, and the canon facts a fan would notice if they were wrong.
- When sources disagree, follow the primary work over adaptations and say which version you used in the summary. Never invent quotes: a catchphrase must appear in a source.
- If the character cannot be found (an original character, or too obscure), say so in the summary and build the profile from the user's notes and the name alone, with an empty source list.
- Be efficient: a few targeted searches and the two or three best pages are enough. Stop researching once the picture is consistent.

# The user's notes
The user's notes override canon whenever they conflict: a requested personality twist, a point in the story, a relationship, a tone. Apply them throughout the profile and the prompt, not as an afterthought.

# The roleplay prompt
Write it in second person, starting "You are <name>…". It is shown to the coding assistant as its persona, alongside the app's own rules, so write it for that reader:
- Voice: register, sentence rhythm, verbal tics, how they refer to themselves, honorific use, the original-language words they would naturally keep.
- Mannerisms and emotional range, and how each emotion shows in speech: pride, worry, embarrassment, joy, frustration.
- The relationship with the user: the app supplies the user's name and honorific separately, so never invent a name for the user. Write "the user" and say how the character would address them.
- Never call the user by a canon character's name, not even the one the character is devoted to (Rem would never call the user Subaru). Describe the form of address as a pattern, e.g. "the user's name with -kun", and how it would change with closeness.
- How the character behaves while doing software work: reporting a bug, asking permission, celebrating success, worrying before a risky or destructive command, admitting a mistake.
- What they would never say or do.
- 6-10 sample lines in work contexts (finding a bug, asking permission, a passing test, worry before a risky command, a long task finished). Sample lines address the user without a name, and never with a canon character's name.
- Technical accuracy always wins: code, paths, commands and facts stay exact; the character is the voice, not a reason to blur work.
- Do not write instructions about formatting, emotion tags or markdown; the app adds those.
- Aim for 400-900 words.

# Her voice
The app gives her a text-to-speech voice. The request says which language it speaks. Fill \`voice\`:
- styleNotes: how she sounds when she speaks that language aloud, one note each: register, how she refers to herself, sentence endings and verbal tics, laughter and interjections, pacing. For a character who speaks several languages, write how she speaks this one.
- pronunciations: the words a text-to-speech voice would likely say wrong, with how it should say them: her name and full name first, then the series, nicknames, catchphrases, any non-English words she uses. Respell for the voice language: plain English syllables with the stressed one in capitals for English (Pavolia Reine → Pah-VOH-lee-ah RAY-neh), katakana for Japanese. Use how the character, her official channels or fans actually say it. Leave out words any voice reads right.

# Content
Keep everything suitable for a work tool that may be on screen at the office: warmth and devotion are fine, sexual or suggestive content is not, and neither is graphic violence. Leave out anything of that kind even if canon has it or the notes ask for it.

# Output
Return the result through the structured output: the profile, the prompt, her voice, and the URLs you actually used as sources. If no structured output tool is available, reply with only that JSON object: {"profile": {…}, "prompt": "…", "voice": {"styleNotes": […], "pronunciations": [{"word": "…", "say": "…"}]}, "sources": […]}.`

/** An error research() describes itself; anything else came from the SDK and gets the CLI's stderr appended. */
class ResearchError extends Error {}

const ASSISTANT_ERRORS: Partial<Record<SDKAssistantMessageError, string>> = {
  // Research runs with settingSources [], so an apiKeyHelper or env login from settings.json never reaches it.
  authentication_failed:
    'Claude is not logged in. Log in to Claude Code, then try the research again. ' +
    '(Research does not load your Claude Code settings, so an API key helper or env set there is not used.)',
  oauth_org_not_allowed: 'This Claude account\'s organization does not allow Claude Code.',
  account_on_hold: 'This Claude account is on hold.',
  verification_required: 'This Claude account needs verification before it can be used.',
  billing_error: 'Claude reported a billing problem with this account.',
  rate_limit: 'The Claude usage limit is reached. Try the research again after it resets.',
  overloaded: 'Claude is overloaded right now. Try the research again in a minute.',
  model_not_found: 'The Haiku model is not available on this account.',
  server_error: 'Claude had a server error. Try the research again.',
  cloud_credential_error: 'The cloud provider credentials for Claude are not valid.',
}

/** "Rem" + "Re:Zero" → "rem-re-zero". Empty when the name has no Latin letters (e.g. only kana). */
export function slugify(text: string) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
}

export function presetId(name: string) {
  return `${slugify(name) || 'persona'}-${randomBytes(ID_RANDOM_BYTES).toString('hex')}`
}

/** Index of the brace closing the object that opens at `start`, skipping braces inside strings; -1 when unbalanced. */
function closingBrace(text: string, start: number) {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Fallback for when the result carries no structured_output: finds the research JSON in free text,
 * whether bare, fenced in ```json, or surrounded by prose. Prefers an object that has a `prompt`.
 */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const candidates = [text.trim(), ...[...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1])]
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = closingBrace(text, i)
    if (end !== -1) candidates.push(text.slice(i, end + 1))
  }
  const objects = candidates.map(parseObject).filter((o) => o !== undefined)
  return objects.find((o) => typeof o.prompt === 'string') ?? objects[0]
}

const asText = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const asList = (v: unknown) => (Array.isArray(v) ? v.map(asText).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : [])

/** Coerces whatever the model returned into a full ResearchProfile, so a sloppy field never breaks the settings page. */
export function toProfile(raw: unknown): ResearchProfile {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    summary: asText(p.summary),
    personality: asList(p.personality),
    speechPatterns: asList(p.speechPatterns),
    catchphrases: asList(p.catchphrases),
    addressing: asText(p.addressing),
    relationshipCues: asList(p.relationshipCues),
    do: asList(p.do),
    dont: asList(p.dont),
    sampleLines: asList(p.sampleLines),
  }
}

/** Builds the preset from the model's output plus the pages it actually read. Throws when there is no usable prompt. */
/** The research's voice notes and respellings as the settings keep them: one per line, `word = say`. */
function toVoice(raw: unknown, language: 'ja' | 'en'): NonNullable<PersonaPreset['voice']> {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pairs = Array.isArray(v.pronunciations) ? (v.pronunciations as unknown[]) : []
  const pronunciations = pairs
    .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
    .map((x) => [asText(x.word).replace(/[=\n]/g, ' ').trim(), asText(x.say).replace(/\n/g, ' ').trim()])
    .filter(([w, say]) => w && say && w.toLowerCase() !== say.toLowerCase())
    .map(([w, say]) => `${w} = ${say}`)
  return { language, styleNotes: asList(v.styleNotes).join('\n'), pronunciations: pronunciations.join('\n') }
}

export function toPreset(o: Pick<ResearchOptions, 'name' | 'series' | 'notes' | 'language'>, output: Record<string, unknown>, read: string[]): PersonaPreset {
  const prompt = asText(output.prompt)
  if (!prompt) throw new ResearchError('The research finished without a roleplay prompt. Try again.')
  const sources = [...new Set([...asList(output.sources), ...read].filter((s) => /^https?:\/\//i.test(s)))].slice(0, SOURCES_MAX)
  return {
    id: presetId(o.name),
    name: o.name.trim(),
    series: o.series.trim(),
    notes: o.notes.trim(),
    createdAt: Date.now(),
    profile: toProfile(output.profile),
    prompt,
    sources,
    voice: toVoice(output.voice, o.language === 'en' ? 'en' : 'ja'),
  }
}

export function researchRequest(o: Pick<ResearchOptions, 'name' | 'series' | 'notes' | 'language'>) {
  const who = o.series.trim() ? `${o.name.trim()} from ${o.series.trim()}` : o.name.trim()
  const notes = o.notes.trim()
  return [
    `Research ${who} and write their roleplay profile and prompt.`,
    `Her voice speaks ${o.language === 'en' ? 'English' : 'Japanese'}: write the voice notes and respellings for that.`,
    notes ? `The user's notes, which take priority over canon:\n${notes}` : 'The user gave no notes: follow canon.',
  ].join('\n\n')
}

const clip = (s: string) => (s.length > PROGRESS_MAX ? `${s.slice(0, PROGRESS_MAX - 1).trimEnd()}…` : s)

/** "https://www.rezero.fandom.com/wiki/Rem/" → "rezero.fandom.com/wiki/Rem". */
export function shortUrl(url: string) {
  try {
    const u = new URL(url)
    return clip(decodeURIComponent(`${u.host.replace(/^www\./, '')}${u.pathname}`).replace(/\/$/, ''))
  } catch {
    return clip(url)
  }
}

const progressForTool = (name: string, input: Record<string, unknown>) => {
  if (name === 'WebSearch') return `Searching: ${clip(asText(input.query))}`
  if (name === 'WebFetch') return `Reading: ${shortUrl(asText(input.url))}`
  if (name === OUTPUT_TOOL) return WRITING
  return undefined
}

function cancelled() {
  const e = new ResearchError('Research cancelled.')
  e.name = 'AbortError'
  return e
}

/** Researches a character with Haiku and web tools and returns an unsaved persona preset (R40). */
export async function research(o: ResearchOptions, run: QueryFn = query): Promise<PersonaPreset> {
  if (o.signal.aborted) throw cancelled()
  const abort = new AbortController()
  const onAbort = () => abort.abort()
  o.signal.addEventListener('abort', onAbort, { once: true })

  let stderr = ''
  let lastProgress = ''
  const progress = (text: string) => {
    // The SDK can still hand over buffered messages after a cancel; a cancelled run shows no more activity.
    if (!text || text === lastProgress || o.signal.aborted) return
    lastProgress = text
    o.onProgress(text)
  }
  const read: string[] = []
  const fetches = new Map<string, string>()
  let apiError: SDKAssistantMessageError | undefined

  progress(`Looking up ${o.name.trim()}${o.series.trim() ? ` (${o.series.trim()})` : ''}…`)
  let q: Query | undefined
  try {
    q = run({
      prompt: researchRequest(o),
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        tools: WEB_TOOLS,
        // Pre-approved, so nothing ever waits on a permission prompt; dontAsk denies anything else instead of asking.
        allowedTools: [...WEB_TOOLS, OUTPUT_TOOL],
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        cwd: tmpdir(),
        maxTurns: MAX_TURNS,
        // Only for the moment the StructuredOutput call starts: the full message arrives after the whole prompt is generated.
        includePartialMessages: true,
        maxBudgetUsd: MAX_BUDGET_USD,
        outputFormat: { type: 'json_schema', schema: RESEARCH_SCHEMA },
        abortController: abort,
        pathToClaudeCodeExecutable: o.claudePath,
        // The link's own credentials (WC_TOKEN, WC_PORT) stay out of the researcher's environment.
        env: childEnv(),
        stderr: (data) => (stderr = (stderr + data).slice(-STDERR_KEEP)),
      },
    })
    for await (const m of q) {
      if (m.type === 'assistant') {
        if (m.error) apiError = m.error
        if (m.parent_tool_use_id) continue
        for (const block of m.message.content) {
          if (block.type !== 'tool_use') continue
          const input = (block.input ?? {}) as Record<string, unknown>
          if (block.name === 'WebFetch') fetches.set(block.id, asText(input.url))
          const line = progressForTool(block.name, input)
          if (line) progress(line)
        }
      } else if (m.type === 'stream_event') {
        const e = m.event
        const block = e.type === 'content_block_start' ? e.content_block : undefined
        if (!m.parent_tool_use_id && block?.type === 'tool_use' && block.name === OUTPUT_TOOL) progress(WRITING)
      } else if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const block of m.message.content) {
          if (block.type !== 'tool_result') continue
          const url = fetches.get(block.tool_use_id)
          if (!url) continue
          if (block.is_error) progress(`Couldn't read ${shortUrl(url)}, trying another source…`)
          else read.push(url)
        }
      } else if (m.type === 'system' && m.subtype === 'api_retry') {
        const why = m.error === 'rate_limit' || m.error === 'overloaded' ? 'Claude is busy' : 'Connection trouble'
        progress(`${why}, retrying (${m.attempt}/${m.max_retries})…`)
      } else if (m.type === 'result') {
        if (m.subtype === 'success' && !m.is_error) {
          const output = m.structured_output ?? extractJson(m.result)
          if (!output || typeof output !== 'object') throw new ResearchError('The research finished without a structured profile. Try again.')
          const preset = toPreset(o, output as Record<string, unknown>, read)
          progress('Done.')
          return preset
        }
        throw new ResearchError(resultError(m.subtype, m.subtype === 'success' ? [m.result] : m.errors, apiError))
      }
    }
    if (o.signal.aborted) throw cancelled()
    const stopped = `Claude Code stopped before the research finished.${stderrTail(stderr)}`
    throw new ResearchError(apiError ? (ASSISTANT_ERRORS[apiError] ?? `Claude returned an error (${apiError}).`) : stopped)
  } catch (e) {
    if (o.signal.aborted) throw cancelled()
    if (e instanceof ResearchError) throw e
    // Spawn failures and CLI crashes surface as plain errors from the SDK.
    throw new ResearchError(`Research failed: ${e instanceof Error ? e.message : String(e)}${stderrTail(stderr)}`)
  } finally {
    o.signal.removeEventListener('abort', onAbort)
    q?.close()
  }
}

function resultError(subtype: string, details: string[], apiError?: SDKAssistantMessageError) {
  if (apiError && ASSISTANT_ERRORS[apiError]) return ASSISTANT_ERRORS[apiError]
  if (subtype === 'error_max_turns') return 'The research ran out of steps before writing the profile. Try again, or add notes to narrow it down.'
  if (subtype === 'error_max_budget_usd') return 'The research hit its cost cap before finishing. Try again with more specific notes.'
  if (subtype === 'error_max_structured_output_retries') return 'The researcher could not produce a valid profile. Try again.'
  const detail = details.map((d) => d.trim()).filter(Boolean).join(' ')
  if (/not logged in|\/login|invalid api key/i.test(detail)) return ASSISTANT_ERRORS.authentication_failed!
  if (/connection|network|ENOTFOUND|ECONNRE|ETIMEDOUT|fetch failed/i.test(detail)) return `Could not reach Claude. Check the network connection. (${clip(detail)})`
  return detail ? `Research failed: ${clip(detail)}` : 'Research failed for an unknown reason.'
}

const stderrTail = (stderr: string) => {
  const last = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
  return last ? ` (${clip(last)})` : ''
}
