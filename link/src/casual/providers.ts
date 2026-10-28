// Who answers in casual mode: any OpenAI-compatible chat API (with a key the person stored), or Claude through
// the Agent SDK with everything Claude Code would add stripped away (no preset, no settings, no built-in tools,
// nothing saved). Both stream text, run her small tool set, and report token use.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, query, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { CasualSettings, Image } from '../protocol.ts'
import { DATA_DIR } from '../settings.ts'
import { childEnv } from '../shell.ts'

export type ChatMsg = { role: 'user' | 'assistant'; content: string; images?: Image[] }
/** A tool she can call. Every parameter is a string, which keeps the schemas tiny and both providers simple. */
export type ToolSpec = {
  name: string
  description: string
  params: Record<string, string>
  run(args: Record<string, string>, signal: AbortSignal): Promise<string>
}
export type Usage = { input: number; cached: number; output: number; calls: number }
export type ChatRequest = {
  system: string
  messages: ChatMsg[]
  tools?: ToolSpec[]
  maxTokens: number
  signal: AbortSignal
  onText(delta: string): void
}
export interface Provider {
  readonly label: string
  chat(req: ChatRequest): Promise<Usage>
  /** One plain answer, no tools, no streaming (learning, judging). */
  complete(system: string, user: string, signal: AbortSignal, maxTokens?: number): Promise<string>
}

/** Tool rounds per reply: enough to look something up, then answer. */
const MAX_TOOL_ROUNDS = 3
const REQUEST_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------- the key

const KEY_FILE = join(DATA_DIR, 'casual-api.key')

export function casualKey(): string {
  const env = process.env.WC_CASUAL_KEY?.trim()
  if (env) return env
  try {
    return existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

export const hasCasualKey = () => casualKey() !== ''

export async function setCasualKey(key: string) {
  const k = key.trim()
  if (!k) return rm(KEY_FILE, { force: true })
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${KEY_FILE}.${process.pid}.tmp`
  await writeFile(tmp, k + '\n', { mode: 0o600 })
  await rename(tmp, KEY_FILE)
}

// ---------------------------------------------------------------- OpenAI-compatible

type OaMsg =
  | { role: 'system' | 'user'; content: string | { type: string; text?: string; image_url?: { url: string } }[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export function openaiProvider(c: CasualSettings, key: string, fetchFn: typeof fetch = fetch): Provider {
  const base = c.baseUrl.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1'
  const official = /api\.openai\.com/.test(base)
  const body = (messages: OaMsg[], maxTokens: number, extra: Record<string, unknown>) => ({
    model: c.model.trim() || 'gpt-6-luna',
    messages,
    // Older OpenAI-compatible servers only know max_tokens; OpenAI's reasoning models only max_completion_tokens.
    ...(official ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(c.reasoningEffort.trim() ? { reasoning_effort: c.reasoningEffort.trim() } : {}),
    ...extra,
  })
  const post = async (payload: unknown, signal: AbortSignal) => {
    const res = await fetchFn(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    if (!res.ok) throw new Error(`${c.model || 'The model'} answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return res
  }
  const toOa = (m: ChatMsg): OaMsg =>
    m.role === 'assistant'
      ? { role: 'assistant', content: m.content }
      : m.images?.length
        ? { role: 'user', content: [...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })), { type: 'text', text: m.content }] }
        : { role: 'user', content: m.content }

  return {
    label: c.model.trim() || 'gpt-6-luna',
    async chat(req) {
      const usage: Usage = { input: 0, cached: 0, output: 0, calls: 0 }
      const messages: OaMsg[] = [{ role: 'system', content: req.system }, ...req.messages.map(toOa)]
      const tools = req.tools?.length
        ? req.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: { type: 'object', properties: Object.fromEntries(Object.entries(t.params).map(([k, d]) => [k, { type: 'string', description: d }])), required: Object.keys(t.params) },
            },
          }))
        : undefined
      for (let round = 0; ; round++) {
        const offerTools = tools && round < MAX_TOOL_ROUNDS
        const res = await post(body(messages, req.maxTokens, { stream: true, stream_options: { include_usage: true }, ...(offerTools ? { tools } : {}) }), req.signal)
        usage.calls++
        const calls: { id: string; name: string; args: string }[] = []
        let text = ''
        for await (const chunk of sse(res.body!)) {
          if (chunk.usage) {
            usage.input += chunk.usage.prompt_tokens ?? 0
            usage.cached += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
            usage.output += chunk.usage.completion_tokens ?? 0
          }
          const d = chunk.choices?.[0]?.delta
          if (!d) continue
          if (d.content) {
            text += d.content
            req.onText(d.content)
          }
          for (const tc of d.tool_calls ?? []) {
            const at = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' })
            if (tc.id) at.id = tc.id
            if (tc.function?.name) at.name += tc.function.name
            if (tc.function?.arguments) at.args += tc.function.arguments
          }
        }
        if (!calls.length || !offerTools) return usage
        messages.push({ role: 'assistant', content: text || null, tool_calls: calls.map((x) => ({ id: x.id, type: 'function', function: { name: x.name, arguments: x.args } })) })
        for (const x of calls) {
          const spec = req.tools!.find((t) => t.name === x.name)
          let out: string
          try {
            out = spec ? await spec.run(parseArgs(x.args), req.signal) : `No tool named ${x.name}.`
          } catch (e) {
            out = `The tool failed: ${e instanceof Error ? e.message : e}`
          }
          messages.push({ role: 'tool', tool_call_id: x.id, content: out })
        }
        // Text before a tool call and the answer after it are one reply on screen.
        if (text && !/\s$/.test(text)) req.onText(' ')
      }
    },
    async complete(system, user, signal, maxTokens = 1500) {
      const res = await post(body([{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens, {}), signal)
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      return j.choices?.[0]?.message?.content ?? ''
    },
  }
}

type Chunk = {
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]
}

/** The data lines of a server-sent event stream, parsed, until [DONE]. */
export async function* sse(stream: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const bytes of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(bytes, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data) as Chunk
      } catch {
        // A keep-alive or a partial line: skip it.
      }
    }
  }
}

function parseArgs(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]))
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------- Claude through the Agent SDK

const CLAUDE_SERVER = 'casual'
/** History goes in as text blocks of this many lines, so the prompt prefix stays the same from turn to turn (prompt caching). */
const LINES_PER_BLOCK = 8

/** The conversation as text blocks for one SDK user message: older lines in stable chunks, the new message last. */
export function claudeBlocks(messages: ChatMsg[], you: string, name: string) {
  const line = (m: ChatMsg) => `${m.role === 'user' ? you : name}: ${m.content}`
  const past = messages.slice(0, -1).map(line)
  const blocks: { type: 'text'; text: string }[] = []
  for (let i = 0; i < past.length; i += LINES_PER_BLOCK) blocks.push({ type: 'text', text: past.slice(i, i + LINES_PER_BLOCK).join('\n') + '\n' })
  if (blocks.length) blocks.unshift({ type: 'text', text: 'The conversation so far:\n' })
  const last = messages.at(-1)
  blocks.push({ type: 'text', text: `${blocks.length ? '\n' : ''}${last?.content ?? ''}` })
  return blocks
}

export function claudeProvider(c: CasualSettings, o: { claudePath?: string; you: string; name: string }): Provider {
  const model = c.claudeModel.trim() || 'sonnet'
  const one = async (system: string, content: SDKUserMessage['message']['content'], signal: AbortSignal, tools: ToolSpec[], onText?: (d: string) => void) => {
    const usage: Usage = { input: 0, cached: 0, output: 0, calls: 0 }
    const abort = new AbortController()
    const stop = () => abort.abort()
    signal.addEventListener('abort', stop, { once: true })
    const server = tools.length
      ? createSdkMcpServer({
          name: CLAUDE_SERVER,
          version: '1.0.0',
          tools: tools.map((t) =>
            tool(t.name, t.description, Object.fromEntries(Object.entries(t.params).map(([k, d]) => [k, z.string().describe(d)])), async (args) => ({
              content: [{ type: 'text' as const, text: await t.run(args as Record<string, string>, signal).catch((e) => `The tool failed: ${e instanceof Error ? e.message : e}`) }],
            })),
          ),
        })
      : undefined
    let text = ''
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
    }
    const q = query({
      prompt: prompt(),
      options: {
        model,
        systemPrompt: system,
        tools: [],
        ...(server ? { mcpServers: { [CLAUDE_SERVER]: server }, allowedTools: tools.map((t) => `mcp__${CLAUDE_SERVER}__${t.name}`) } : {}),
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        thinking: { type: 'disabled' },
        maxTurns: tools.length ? MAX_TOOL_ROUNDS + 1 : 1,
        includePartialMessages: !!onText,
        cwd: tmpdir(),
        abortController: abort,
        pathToClaudeCodeExecutable: o.claudePath,
        env: childEnv(),
      },
    })
    try {
      for await (const m of q) {
        if (m.type === 'stream_event' && !m.parent_tool_use_id) {
          const e = m.event
          if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
            text += e.delta.text
            onText?.(e.delta.text)
          }
          if (e.type === 'message_start' && text && !/\s$/.test(text)) onText?.(' ')
        } else if (m.type === 'assistant' && !onText && !m.parent_tool_use_id) {
          for (const b of m.message.content) if (b.type === 'text') text += b.text
        } else if (m.type === 'result') {
          usage.calls = m.num_turns
          usage.input = m.usage.input_tokens + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0)
          usage.cached = m.usage.cache_read_input_tokens ?? 0
          usage.output = m.usage.output_tokens
          if (m.subtype !== 'success' && !text) throw new Error(`Claude stopped: ${m.subtype}`)
          if (m.subtype === 'success' && m.is_error && !text) throw new Error(m.result || 'Claude returned an error.')
        }
      }
    } finally {
      signal.removeEventListener('abort', stop)
      q.close()
    }
    return { usage, text }
  }

  return {
    label: `Claude ${model}`,
    async chat(req) {
      const blocks: SDKUserMessage['message']['content'] = [
        ...(req.messages.at(-1)?.images ?? []).map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
        ...claudeBlocks(req.messages, o.you, o.name),
      ]
      return (await one(req.system, blocks, req.signal, req.tools ?? [], req.onText)).usage
    },
    async complete(system, user, signal) {
      return (await one(system, user, signal, [])).text
    },
  }
}

// ---------------------------------------------------------------- the E2E suite's stand-in

/** Lines the promotional video (scripts/pv/record.mjs) says, so its casual scenes read like her. */
const MOCK_LINES: [RegExp, string][] = [
  [/long day|done for today/i, '[happy] You made it! [smile] Come sit for a bit, I\'ll make tea. …Tell me the worst part first.'],
  [/mia\b.*\b(visit|coming)/i, '[surprised] Mia\'s visiting? [delighted] Then I\'ll help you tidy up. [pout] The laundry is still yours, though.'],
  [/who.*visiting|sister.*name/i, '[smile] Mia, of course. [shy] I remember everything you tell me, you know.'],
]

/** WC_MOCK: replies at once from a script, so tests never call a model. */
export function mockProvider(): Provider {
  return {
    label: 'mock',
    async chat(req) {
      const last = req.messages.at(-1)?.content ?? ''
      const said = last.replace(/<waifufy-context>[\s\S]*?<\/waifufy-context>\s*/, '').trim()
      const work = /\b(fix|bug|code|deploy|test|refactor)\b/i.test(said) ? 1 : 0
      const line = MOCK_LINES.find(([re]) => re.test(said))?.[1] ?? `[smile] Casual mock reply to: ${said.slice(0, 80)}`
      const reply = `<feel joy=0.4 sadness=0 anger=0 surprise=0.1 fear=0 sure=0.9 work=${work}/>\n${line}`
      for (const part of reply.match(/.{1,12}/gs) ?? []) {
        if (req.signal.aborted) break
        req.onText(part)
        await new Promise((r) => setTimeout(r, 2))
      }
      return { input: 0, cached: 0, output: 0, calls: 1 }
    },
    async complete() {
      return '{}'
    },
  }
}

/** The E2E suite's mock link answers casual messages from a script, unless a test asks for the real thing. */
export const mockCasual = () => process.env.WC_MOCK === '1' && process.env.WC_REAL_CASUAL !== '1'

/** The provider settings and the stored key pick: an OpenAI-compatible API when chosen and keyed, else Claude. */
export function pickProvider(c: CasualSettings, o: { claudePath?: string; you: string; name: string }): Provider {
  if (mockCasual() && !process.env.WC_CASUAL_KEY) return mockProvider()
  const key = casualKey()
  return c.provider === 'openai' && key ? openaiProvider(c, key) : claudeProvider(c, o)
}
