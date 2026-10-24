/**
 * The agent bridge: the frontend's chat talks to the Claude Code on this machine through the
 * Claude Agent SDK, so it runs on the developer's own Claude login, no API key.
 *
 *   POST /api/agent/chat        { messages, system?, tools? }  ->  AI SDK UI message stream (SSE)
 *   POST /api/agent/tools/:id   { output } | { error }         ->  answers one tool call
 *
 * The page owns the tools. It sends their JSON Schemas (`tools`) and a description of what is
 * on screen (`system`) with every request; the bridge offers them to Claude as one in-process
 * MCP server. When Claude calls one, the bridge streams the call to the page as a tool part,
 * waits for the page to post the result back, and hands that to Claude, so one run can call
 * many tools without restarting. Built-in tools, other MCP servers and filesystem settings
 * stay off. Thinking is adaptive; its summary streams to the page as reasoning parts.
 *
 * The bridge keeps no sessions; each request carries the whole conversation, so edits and
 * regenerations need nothing special.
 */

import {
  createSdkMcpServer,
  type Options,
  query,
  type SDKMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageStreamWriter,
} from 'ai'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

/** One agent run; the Agent SDK's `query` in production, a fake in tests. */
export type RunAgent = (run: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>

/** A tool as the page declares it (assistant-ui's `ToolJSONSchema`). */
export interface PageTool {
  description?: string
  /** JSON Schema of the tool's input object. */
  parameters: Record<string, unknown>
}

/** What the page posts back for one call. */
export type ToolAnswer = { output: unknown } | { error: string }

/** The MCP server name; Claude sees the tools as `mcp__page__<name>`. */
const SERVER = 'page'
/** How long a call may wait for the page before Claude is told it did not answer. */
const ANSWER_TIMEOUT_MS = 120_000
/** Tool output kept per call in the transcript of earlier turns. */
const TRANSCRIPT_OUTPUT_CHARS = 1_500

const SYSTEM_PROMPT = `You are the assistant inside hockeymask, a tool for mapping a connected source system into a target data model.
The user connects a source system (an ERP such as NetSuite, a data warehouse such as Snowflake) and builds mappings: graphs of steps that turn the source's tables into the entities of the target model (products, categories, suppliers, warehouses, inventory levels, ...).

You work in the user's browser page through tools: discover the source tables, read the target model, create, edit and delete mappings, and run a mapping in the testbench. The <page> block below describes what the user has open right now; refer to it when they say "this mapping" or "the selected step".

How to build a mapping:
1. Look first: describe the source tables (and sample a few rows) and the target entity you write to. Call mapping_reference for the exact params of a step or op you are unsure about.
2. Write the graph with edit_mapping. Every edit returns the mapping's issues and the fields each step outputs; fix the issues before you go on.
3. Debug with run_testbench (sample rows by default, or rows you write to probe edge cases) and check the rows that reach each sink. Iterate until the mapping is clean, then summarise what it does and anything doubtful.
Your edits are unsaved drafts in the builder; the user reviews and saves them. Delete a mapping only when the user asks for it.

The mapping document:
- Nodes are flat objects { id, op, label?, ...params } that reference their inputs by id: \`in\` for single-input steps, \`left\`/\`right\` for join, \`inputs\` for union. There is no edge list. Use short readable ids ("items", "products", "write_products").
- The usual chain is source { system, entity } -> map { in, fields: [{ key, pipeline }] } -> sink { in, target, key }. filter, join, aggregate, distinct and union go in between.
- A map field pipeline is a list of record ops, starting with extract { path }, const { value } or coalesce { paths }, e.g. [{ "op": "extract", "path": "upccode" }, { "op": "blank_to_null" }] or [{ "op": "extract", "path": "cost" }, { "op": "if_lte", "value": 0, "then": null }].
- A field key names a target path ("product.sku", or a bare field of the sink's target). sink.key lists the upsert key's target paths; they must be non-null, unless the target identity matches NULLs as equal (the entity's nullsNotDistinct). One sink per target entity.
- sink.mode "replace" makes each run the full set of the target and deletes rows it no longer writes: use it for fully derived entities such as a current stock snapshot (inventory_level). It requires a count expectation on the sink's input with a min and onFail "stop" (or "skip_downstream"), e.g. expect: { "stock_rows": { "count": { "min": 1000, "max": 50000 }, "onFail": "stop" } }.
- A reference field (product_id, warehouse_id, category_id, ...) takes a natural key of the entity it points to; declare it in sink.refs, e.g. { "product_id": { "by": ["sku"] } } or { "warehouse_id": { "by": ["source_id"] } }; a key of several fields takes a tuple from extract { path: [a, b] }.
- Counters for the run: metrics { in, name, count_by: [field] } reports the number of rows per value; a keyed expect on it can alert on one counter.
- Predicates (filter cond, when cases, join where): { path?, <eq|neq|lt|lte|gt|gte|in|not_in|matches|is_null|is_blank|before|after>: operand }, or { all: { of: [...] } }, { any: { of: [...] } }, { not: cond }. An operand is a literal, { ref: field } or { param: name }.
- Every node must reach a sink (or metrics/assert), no cycles. Source schemas are filled in from the table automatically.

Keep answers short and concrete. Use Markdown; put field names, SQL and JSON in code.`

const textOf = (message: UIMessage) =>
  message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim()

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text

/** Earlier tool calls, so a follow-up turn knows what the last one did. */
function toolsOf(message: UIMessage): string[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'dynamic-tool') return []
    const result =
      part.state === 'output-available'
        ? clip(JSON.stringify(part.output) ?? 'null', TRANSCRIPT_OUTPUT_CHARS)
        : part.state === 'output-error'
          ? `error: ${part.errorText}`
          : 'no result'
    return [`<tool name="${part.toolName}">\n${JSON.stringify(part.input)}\n-> ${result}\n</tool>`]
  })
}

/** The last user message, with the turns before it (and their tool calls) as context. */
export function toPrompt(messages: readonly UIMessage[]): string {
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, text: [...toolsOf(m), textOf(m)].filter(Boolean).join('\n') }))
    .filter((t) => t.text)
  const last = turns.at(-1)
  if (!last || last.role !== 'user') {
    throw new HTTPException(400, { message: 'The conversation must end with a user message.' })
  }
  const history = turns.slice(0, -1)
  if (history.length === 0) return last.text
  const transcript = history.map((t) => `<${t.role}>\n${t.text}\n</${t.role}>`).join('\n')
  return `<conversation>\n${transcript}\n</conversation>\n\n${last.text}`
}

/** The page's tools as zod shapes for the Agent SDK; a schema that is not an object is skipped. */
function shapeOf(tool: PageTool): z.ZodRawShape | null {
  try {
    const schema = z.fromJSONSchema(tool.parameters as Parameters<typeof z.fromJSONSchema>[0])
    return schema instanceof z.ZodObject ? schema.shape : null
  } catch {
    return null
  }
}

interface ChatBody {
  messages?: UIMessage[]
  system?: string
  tools?: Record<string, PageTool>
}

export function agentRoutes(run: RunAgent = query) {
  /** Calls handed to the page, by tool call id, until it answers. */
  const waiting = new Map<string, (answer: ToolAnswer) => void>()

  /** Stream one call to the page and wait for its answer. */
  async function callPage(
    writer: UIMessageStreamWriter,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolAnswer> {
    const toolCallId = crypto.randomUUID()
    const answer = new Promise<ToolAnswer>((resolve) => {
      const timer = setTimeout(
        () => resolve({ error: 'The page did not answer in time.' }),
        ANSWER_TIMEOUT_MS,
      )
      const done = (value: ToolAnswer) => {
        clearTimeout(timer)
        waiting.delete(toolCallId)
        resolve(value)
      }
      waiting.set(toolCallId, done)
      signal.addEventListener('abort', () => done({ error: 'Stopped.' }), { once: true })
    })
    writer.write({ type: 'tool-input-available', toolCallId, toolName, input, dynamic: true })
    const result = await answer
    writer.write(
      'error' in result
        ? { type: 'tool-output-error', toolCallId, errorText: result.error, dynamic: true }
        : { type: 'tool-output-available', toolCallId, output: result.output, dynamic: true },
    )
    return result
  }

  /** One in-process MCP server whose tools all relay to the page. */
  function pageServer(
    tools: Record<string, PageTool>,
    writer: UIMessageStreamWriter,
    signal: AbortSignal,
  ) {
    const definitions = Object.entries(tools).flatMap(([name, spec]) => {
      const shape = shapeOf(spec)
      if (!shape) return []
      return [
        tool(name, spec.description ?? name, shape, async (input) => {
          const result = await callPage(writer, name, input, signal)
          return 'error' in result
            ? { content: [{ type: 'text' as const, text: result.error }], isError: true }
            : {
                content: [{ type: 'text' as const, text: JSON.stringify(result.output) ?? 'null' }],
              }
        }),
      ]
    })
    return {
      names: definitions.map((d) => `mcp__${SERVER}__${d.name}`),
      server: createSdkMcpServer({
        name: SERVER,
        tools: definitions,
        alwaysLoad: true,
        timeout: ANSWER_TIMEOUT_MS + 5_000,
      }),
    }
  }

  const options = (body: ChatBody, writer: UIMessageStreamWriter, abort: AbortController) => {
    const page = body.system?.trim()
    const base: Options = {
      systemPrompt: page ? `${SYSTEM_PROMPT}\n\n<page>\n${page}\n</page>` : SYSTEM_PROMPT,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      includePartialMessages: true,
      // Claude decides when and how much to think; the summary streams to the chat. At the
      // SDK's default effort it rarely thinks at all.
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
      maxTurns: 1,
      model: process.env.AGENT_MODEL,
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH,
      abortController: abort,
    }
    const tools = body.tools ?? {}
    if (Object.keys(tools).length === 0) return base
    const { names, server } = pageServer(tools, writer, abort.signal)
    return {
      ...base,
      mcpServers: { [SERVER]: server },
      allowedTools: names,
      // Anything not allowed above is refused instead of waiting for a permission prompt.
      permissionMode: 'dontAsk',
      maxTurns: 60,
    } satisfies Options
  }

  return new Hono()
    .post('/chat', async (c) => {
      const body = (await c.req.json().catch(() => null)) as ChatBody | null
      if (!Array.isArray(body?.messages)) {
        throw new HTTPException(400, { message: 'Expected { messages: UIMessage[] }.' })
      }
      const prompt = toPrompt(body.messages)
      // Stop Claude, and every call waiting on the page, when the browser stops listening.
      const abort = new AbortController()
      c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true })

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          writer.write({ type: 'start' })
          // The content block being streamed: Claude's text, or its (summarised) thinking.
          let open: { kind: 'text' | 'reasoning'; id: string } | null = null
          let blocks = 0
          for await (const message of run({ prompt, options: options(body, writer, abort) })) {
            if (message.type === 'stream_event') {
              const { event } = message
              if (event.type === 'content_block_start') {
                const kind =
                  event.content_block.type === 'text'
                    ? 'text'
                    : event.content_block.type === 'thinking'
                      ? 'reasoning'
                      : null
                if (kind) {
                  open = { kind, id: `${kind}-${blocks++}` }
                  writer.write({ type: `${kind}-start`, id: open.id })
                }
              } else if (open && event.type === 'content_block_delta') {
                const { delta } = event
                if (open.kind === 'text' && delta.type === 'text_delta') {
                  writer.write({ type: 'text-delta', id: open.id, delta: delta.text })
                } else if (open.kind === 'reasoning' && delta.type === 'thinking_delta') {
                  writer.write({ type: 'reasoning-delta', id: open.id, delta: delta.thinking })
                }
              } else if (open && event.type === 'content_block_stop') {
                writer.write({ type: `${open.kind}-end`, id: open.id })
                open = null
              }
            } else if (message.type === 'result') {
              if (message.subtype !== 'success') {
                throw new Error(message.errors.join('\n') || `Claude stopped: ${message.subtype}`)
              }
              // E.g. "Not logged in": a failed run still ends in a 'success' result.
              if (message.is_error) throw new Error(message.result || 'Claude failed.')
            }
          }
          writer.write({ type: 'finish', finishReason: 'stop' })
        },
        onError: (error) => (error instanceof Error ? error.message : 'The agent failed.'),
      })
      return createUIMessageStreamResponse({ stream })
    })
    .post('/tools/:id', async (c) => {
      const answer = waiting.get(c.req.param('id'))
      if (!answer) throw new HTTPException(404, { message: 'No tool call is waiting on that id.' })
      const body = (await c.req.json().catch(() => null)) as Partial<
        Record<'output' | 'error', unknown>
      > | null
      answer(
        typeof body?.error === 'string'
          ? { error: body.error }
          : { output: body?.output === undefined ? null : body.output },
      )
      return c.body(null, 204)
    })
}
