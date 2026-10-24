import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
  useAssistantContext,
} from '@assistant-ui/react'
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import {
  ArrowUp,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Database,
  type LucideIcon,
  Orbit,
  PencilLine,
  Play,
  Plus,
  RotateCcw,
  Rows3,
  Sparkles,
  Square,
  SquarePen,
  Table2,
  TextCursorInput,
  Trash2,
  Workflow,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'
import remarkGfm from 'remark-gfm'
import { api } from '../api'
import { describeIntegrations } from '../lib/agent/context'
import { runTool, TOOL_SCHEMAS, type ToolName, toolLabel } from '../lib/agent/tools'
import { getState, openMapping } from '../lib/store'
import { AGENT_WIDTH, Panel } from './ui'

/**
 * The API's bridge to the Claude Code on the developer's machine. Every request carries the
 * page's tools; what is on screen goes along as `system`, from `useAssistantContext`.
 */
const transport = new AssistantChatTransport({
  api: '/api/agent/chat',
  body: { tools: TOOL_SCHEMAS },
})

/**
 * The bridge streams each tool call here and waits: run it on the page and post the answer
 * back. Not awaited, so the stream keeps flowing; a stopped run just ignores the answer.
 */
function answerToolCall({
  toolCall,
}: {
  toolCall: { toolCallId: string; toolName: string; input: unknown }
}) {
  void runTool(toolCall.toolName, toolCall.input)
    .then((answer) => api.answerTool(toolCall.toolCallId, answer))
    .catch(() => undefined)
}

/** Which integrations and mappings exist and which is open, read when a message is sent. */
function IntegrationsContext() {
  useAssistantContext({
    getContext: () => {
      const state = getState()
      return describeIntegrations(state.integrations, openMapping(state))
    },
  })
  return null
}

/**
 * Holds the conversation. Lives above the workspace, so switching mappings (which remounts
 * the workspace) keeps the chat.
 */
export function AgentRuntime({ children }: { children: ReactNode }) {
  const runtime = useChatRuntime({ transport, onToolCall: answerToolCall })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <IntegrationsContext />
      {children}
    </AssistantRuntimeProvider>
  )
}

const SUGGESTIONS = [
  'Map their items to products',
  'Run this mapping in the testbench and explain the issues',
  'What does the selected step do?',
]

const iconButton =
  'grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg'

/** Markdown in 13px panel type; every rule scoped to the message. */
const PROSE = [
  'text-[13px] leading-[1.6] break-words text-fg',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_p]:my-2 [&_strong]:font-semibold',
  '[&_h1]:mt-4 [&_h1]:mb-1.5 [&_h1]:text-[14px] [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-[13.5px] [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold',
  '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-4',
  '[&_li]:my-0.5 [&_li]:marker:text-faint',
  '[&_a]:text-num [&_a]:underline [&_a]:underline-offset-2',
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-raised [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[12px]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-canvas [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-[1.5]',
  '[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_table]:text-[12px]',
  '[&_td]:border-b [&_td]:border-line [&_td]:py-1 [&_td]:pr-3 [&_th]:border-b [&_th]:border-line-strong [&_th]:py-1 [&_th]:pr-3 [&_th]:text-left [&_th]:font-medium',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted',
  '[&_hr]:my-3 [&_hr]:border-line',
].join(' ')

const MarkdownText = () => <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className={PROSE} />

/** Icons echo the page: tables and mappings look as they do in the input panel. */
const TOOL_ICONS: Readonly<Record<ToolName, LucideIcon>> = {
  list_tables: Database,
  describe_table: Table2,
  sample_rows: Rows3,
  get_target_model: Orbit,
  mapping_reference: BookOpen,
  create_mapping: Plus,
  rename_mapping: TextCursorInput,
  delete_mapping: Trash2,
  get_mapping: Workflow,
  edit_mapping: PencilLine,
  run_testbench: Play,
}

const toolIcon = (name: string) =>
  Object.hasOwn(TOOL_ICONS, name) ? TOOL_ICONS[name as ToolName] : Wrench

/** A quiet line in an answer, open for details: one tool call, or Claude's thinking. */
function Step({
  icon: Icon,
  label,
  active = false,
  failed = false,
  children,
}: {
  icon: LucideIcon
  label: string
  active?: boolean
  failed?: boolean
  children: ReactNode
}) {
  return (
    <details className="group text-[12.5px] leading-[1.5]">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-faint transition-colors select-none hover:text-muted [&::-webkit-details-marker]:hidden">
        <Icon
          size={13}
          strokeWidth={1.5}
          aria-label={failed ? 'Failed' : undefined}
          className={`shrink-0 ${failed ? 'text-down/80' : ''}`}
        />
        <span className={`truncate ${active ? 'animate-pulse' : ''}`}>{label}</span>
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className="shrink-0 opacity-0 transition group-open:rotate-90 group-open:opacity-100 group-hover:opacity-100"
        />
      </summary>
      <div className="mt-1 mb-1.5 ml-[21px]">{children}</div>
    </details>
  )
}

/** One line per tool call; open it for what the page answered. */
function ToolCall({ toolName, args, result, isError, status }: ToolCallMessagePartProps) {
  const running = result === undefined && status.type === 'running'
  const shown: unknown = result === undefined ? args : result
  return (
    <Step
      icon={toolIcon(toolName)}
      label={toolLabel(toolName, args)}
      active={running}
      failed={Boolean(isError) || (result === undefined && !running)}
    >
      <pre className="max-h-60 overflow-auto rounded-lg border border-line bg-canvas p-2 font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap text-faint">
        {typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2)}
      </pre>
    </Step>
  )
}

/** Claude's summarised thinking, folded away like the tool calls. */
function Reasoning({ text, status }: ReasoningMessagePartProps) {
  const thinking = status.type === 'running'
  if (!text.trim() && !thinking) return null
  return (
    <Step icon={Brain} label={thinking ? 'Thinking…' : 'Thought'} active={thinking}>
      <p className="text-[12px] leading-[1.55] whitespace-pre-wrap text-faint">{text}</p>
    </Step>
  )
}

/** Until the first token arrives. */
const Thinking = () => (
  <p className="flex items-center gap-2 text-[12.5px] leading-[1.5] text-faint">
    <Brain size={13} strokeWidth={1.5} className="shrink-0" />
    <span className="animate-pulse">Thinking…</span>
  </p>
)

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ml-6 self-end rounded-xl bg-raised px-3 py-2 text-[13px] leading-[1.5] break-words whitespace-pre-wrap">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-1.5">
      <MessagePrimitive.Parts
        components={{
          Text: MarkdownText,
          Reasoning,
          Empty: Thinking,
          tools: { Fallback: ToolCall },
        }}
      />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="rounded-lg border border-down/25 bg-down/10 px-2.5 py-2 text-[12.5px] leading-[1.5] text-down">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="-ml-1.5 flex gap-0.5">
        <ActionBarPrimitive.Copy aria-label="Copy" title="Copy" className={iconButton}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <Check size={14} strokeWidth={1.75} className="text-ok" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <Copy size={14} strokeWidth={1.5} />
          </AuiIf>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload
          aria-label="Regenerate"
          title="Regenerate"
          className={iconButton}
        >
          <RotateCcw size={14} strokeWidth={1.5} />
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  )
}

function Welcome() {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-start gap-2 text-muted">
        <Sparkles size={15} strokeWidth={1.5} className="mt-[2.5px] shrink-0" />
        <p className="text-[13px] leading-[1.5]">
          Ask about the source data, or have the agent build and test a mapping.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        {SUGGESTIONS.map((prompt) => (
          <ThreadPrimitive.Suggestion
            key={prompt}
            prompt={prompt}
            send
            className="rounded-lg border border-line px-2.5 py-2 text-left text-[12.5px] leading-[1.45] text-muted transition-colors hover:border-line-strong hover:bg-raised hover:text-fg"
          >
            {prompt}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  )
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="m-2 mt-0 flex shrink-0 flex-col rounded-xl border border-line-strong bg-raised/50 transition-colors focus-within:border-[#3a3c42]">
      <ComposerPrimitive.Input
        rows={1}
        maxRows={8}
        placeholder="Ask the agent…"
        aria-label="Message the agent"
        className="resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-[1.5] text-fg outline-none placeholder:text-faint"
      />
      <div className="flex h-9 items-center justify-between pr-1.5 pl-3">
        <span className="text-[11.5px] text-faint">Claude · local</span>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send
            aria-label="Send"
            className="grid size-7 place-items-center rounded-full bg-fg text-frame transition-opacity hover:bg-white disabled:opacity-25"
          >
            <ArrowUp size={15} strokeWidth={2} />
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel
            aria-label="Stop"
            className="grid size-7 place-items-center rounded-full bg-fg text-frame hover:bg-white"
          >
            <Square size={10} strokeWidth={0} fill="currentColor" />
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  )
}

/** Right: a chat with the agent, on the developer's local Claude via the API, with page tools. */
export function AgentPanel({ onClose }: { onClose: () => void }) {
  return (
    <Panel
      title="Agent"
      fill
      width={AGENT_WIDTH}
      onClose={onClose}
      header={
        <div className="flex items-center pl-2">
          <h2 className="flex-1 text-[13px] font-semibold tracking-[-0.01em]">Agent</h2>
          <AuiIf condition={(s) => !s.thread.isEmpty}>
            <ThreadListPrimitive.New aria-label="New chat" title="New chat" className={iconButton}>
              <SquarePen size={14} strokeWidth={1.5} />
            </ThreadListPrimitive.New>
          </AuiIf>
        </div>
      }
    >
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-1 pb-4">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <Welcome />
          </AuiIf>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <Composer />
      </ThreadPrimitive.Root>
    </Panel>
  )
}
