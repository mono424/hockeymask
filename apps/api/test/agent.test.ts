import type {
  McpSdkServerConfigWithInstance,
  Options,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vite-plus/test'
import { agentRoutes, type RunAgent, toPrompt } from '../src/agent'

const user = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  parts: [{ type: 'text', text }],
})
const assistant = (text: string): UIMessage => ({ ...user(text), role: 'assistant' })

const event = (e: unknown) => ({ type: 'stream_event', event: e }) as unknown as SDKMessage
const result = (fields: Record<string, unknown>) =>
  ({ type: 'result', subtype: 'success', is_error: false, result: '', ...fields }) as SDKMessage

/** A runner that replays these messages and records what it was asked. */
function fake(messages: SDKMessage[]) {
  const calls: Parameters<RunAgent>[0][] = []
  const run: RunAgent = async function* (call) {
    calls.push(call)
    yield* messages
  }
  return { run, calls }
}

const post = (routes: ReturnType<typeof agentRoutes>, path: string, body: unknown) =>
  routes.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const chat = (run: RunAgent, body: unknown) => post(agentRoutes(run), '/chat', body)

interface Chunk {
  type: string
  delta?: string
  errorText?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
}

const parse = (text: string): Chunk[] =>
  text
    .split('\n\n')
    .map((line) => line.replace(/^data: /, ''))
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as Chunk)

/** The UI message chunks of an SSE response. */
const chunks = async (response: Response) => parse(await response.text())

/** Read an SSE response chunk by chunk, letting `onChunk` act (e.g. answer a tool call). */
async function follow(response: Response, onChunk: (chunk: Chunk) => Promise<void>) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const seen: Chunk[] = []
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const end = buffer.lastIndexOf('\n\n')
    if (end < 0) continue
    for (const chunk of parse(buffer.slice(0, end))) {
      seen.push(chunk)
      await onChunk(chunk)
    }
    buffer = buffer.slice(end + 2)
  }
  return seen
}

/** Call a page tool the way Claude would, through the in-process MCP server. */
function callTool(options: Options, name: string, input: unknown) {
  const server = options.mcpServers?.page as McpSdkServerConfigWithInstance
  // The MCP SDK keeps registered tools here; no public API calls one without a transport.
  const tools = (server.instance as unknown as { _registeredTools: Record<string, Handler> })
    ._registeredTools
  return (tools[name] as Handler).handler(input, {})
}
type Handler = { handler: (input: unknown, extra: unknown) => Promise<unknown> }

const ECHO = {
  echo: {
    description: 'Echo text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
}

describe('agent bridge', () => {
  it('streams Claude text as UI message chunks, with no tools', async () => {
    const { run, calls } = fake([
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      event({ type: 'content_block_stop', index: 0 }),
      result({ result: 'Hello' }),
    ])
    const out = await chunks(await chat(run, { messages: [user('Hi')] }))
    expect(out.map((c) => c.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ])
    expect(out.flatMap((c) => c.delta ?? []).join('')).toBe('Hello')
    expect(calls[0]?.prompt).toBe('Hi')
    expect(calls[0]?.options).toMatchObject({ tools: [], mcpServers: {}, settingSources: [] })
  })

  it('streams thinking as reasoning, before the answer', async () => {
    const { run, calls } = fake([
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Hm' },
      }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta' } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Yes' } }),
      event({ type: 'content_block_stop', index: 1 }),
      result({}),
    ])
    const out = await chunks(await chat(run, { messages: [user('Hi')] }))
    expect(out.map((c) => [c.type, c.delta])).toEqual([
      ['start', undefined],
      ['reasoning-start', undefined],
      ['reasoning-delta', 'Hm'],
      ['reasoning-end', undefined],
      ['text-start', undefined],
      ['text-delta', 'Yes'],
      ['text-end', undefined],
      ['finish', undefined],
    ])
    expect(calls[0]?.options).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
    })
  })

  it('reports a failed run as an error chunk', async () => {
    const { run } = fake([result({ is_error: true, result: 'Not logged in · Please run /login' })])
    const out = await chunks(await chat(run, { messages: [user('Hi')] }))
    expect(out).toContainEqual({ type: 'error', errorText: 'Not logged in · Please run /login' })
  })

  it('relays tool calls to the page and its answers back to Claude', async () => {
    const results: unknown[] = []
    const run: RunAgent = async function* ({ options }) {
      results.push(await callTool(options, 'echo', { text: 'hi' }))
      results.push(await callTool(options, 'echo', { text: 'boom' }))
      yield result({})
    }
    const routes = agentRoutes(run)
    const response = await post(routes, '/chat', {
      messages: [user('Echo hi')],
      system: 'Open mapping: Items',
      tools: ECHO,
    })
    const out = await follow(response, async (chunk) => {
      if (chunk.type !== 'tool-input-available') return
      const text = (chunk.input as { text: string }).text
      const answer = text === 'boom' ? { error: 'It broke.' } : { output: { said: text } }
      expect((await post(routes, `/tools/${chunk.toolCallId}`, answer)).status).toBe(204)
    })
    expect(out.map((c) => c.type)).toEqual([
      'start',
      'tool-input-available',
      'tool-output-available',
      'tool-input-available',
      'tool-output-error',
      'finish',
    ])
    expect(out[2]?.output).toEqual({ said: 'hi' })
    expect(out[4]?.errorText).toBe('It broke.')
    expect(results).toEqual([
      { content: [{ type: 'text', text: '{"said":"hi"}' }] },
      { content: [{ type: 'text', text: 'It broke.' }], isError: true },
    ])
  })

  it('offers only the page tools, with the page described in the system prompt', async () => {
    const { run, calls } = fake([result({})])
    await chunks(await chat(run, { messages: [user('Hi')], system: 'Open: Items', tools: ECHO }))
    const options = calls[0]?.options as Options
    expect(options).toMatchObject({
      tools: [],
      allowedTools: ['mcp__page__echo'],
      permissionMode: 'dontAsk',
    })
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['page'])
    expect(options.systemPrompt).toContain('<page>\nOpen: Items\n</page>')
  })

  it('404s an answer nobody is waiting for', async () => {
    const { run } = fake([])
    expect((await post(agentRoutes(run), '/tools/nope', { output: 1 })).status).toBe(404)
  })

  it('rejects a body without messages', async () => {
    const { run } = fake([])
    expect((await chat(run, {})).status).toBe(400)
  })
})

describe('toPrompt', () => {
  it('sends the last user message with the turns before it as context', () => {
    const prompt = toPrompt([user('What is a sink?'), assistant('A target.'), user('Shorter?')])
    expect(prompt).toBe(
      '<conversation>\n<user>\nWhat is a sink?\n</user>\n<assistant>\nA target.\n</assistant>\n</conversation>\n\nShorter?',
    )
  })

  it('keeps earlier tool calls in the transcript', () => {
    const called: UIMessage = {
      id: 'a',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'create_mapping',
          toolCallId: 't1',
          state: 'output-available',
          input: { name: 'Items' },
          output: { mappingId: 'ns--items' },
        },
        { type: 'text', text: 'Created it.' },
      ],
    }
    const prompt = toPrompt([user('Make one'), called, user('Now delete it')])
    expect(prompt).toContain(
      '<tool name="create_mapping">\n{"name":"Items"}\n-> {"mappingId":"ns--items"}\n</tool>\nCreated it.',
    )
  })
})
