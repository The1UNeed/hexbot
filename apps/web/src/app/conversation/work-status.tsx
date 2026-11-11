import {
  AudioLines,
  Brain,
  ChartColumn,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Code,
  Eye,
  FilePen,
  FileText,
  FolderSearch,
  Globe,
  Image,
  KeyRound,
  ListTodo,
  type LucideIcon,
  MousePointer2,
  Puzzle,
  Sparkles,
  SquareTerminal,
  Users,
  Wrench
} from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { ScrollArea } from '../../components/ui/scroll-area'
import { cn } from '../../lib/cn'
import type { Message, ToolCall } from '../../lib/types'
import type { WorkLabel } from '../../lib/work-label'

import { ASKING_TOOL, asks, toolLabel, workLabel, workSentence } from './steps'

const format = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

const ICONS: Record<string, LucideIcon> = {
  browser_click: MousePointer2,
  browser_navigate: Globe,
  browser_type: MousePointer2,
  cronjob_manage: Clock,
  delegate_task: Users,
  codemode: Code,
  execute_code: Code,
  hexbot_passwords: KeyRound,
  hexbot_plugins: Puzzle,
  hexbot_share_file: FileText,
  hexbot_show_html: ChartColumn,
  hexbot_soul: Sparkles,
  image_generate: Image,
  ls: FolderSearch,
  memory: Brain,
  patch: FilePen,
  read_file: FileText,
  search_files: FolderSearch,
  session_search: FolderSearch,
  skill_view: Sparkles,
  skills_list: Sparkles,
  terminal: SquareTerminal,
  text_to_speech: AudioLines,
  todo_list: ListTodo,
  video_generate: Image,
  vision_analyze: Eye,
  web_extract: Globe,
  web_search: Globe,
  write_file: FilePen
}

/** The glyph for a tool, so a step reads at a glance: a terminal, a globe, a file. */
export function toolIcon(name: string): LucideIcon {
  return ICONS[name] ?? Wrench
}

/** A finished step's mark: a check, or a red alert when it failed. */
function StepMark({ call }: { call: ToolCall }) {
  if (call.status === 'running') {
    return <span className="size-1.5 shrink-0 rounded-full bg-info" />
  }

  return call.status === 'error' ? (
    <CircleAlert className="shrink-0 text-danger" size={13} />
  ) : (
    <Check className="shrink-0 text-success" size={13} />
  )
}

/**
 * One step: its glyph, what it did, and its mark. Its arguments and output
 * stay closed until clicked. Shared with the panel's Computer tab.
 */
export function StepRow({ call, meta }: { call: ToolCall; meta?: ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  const running = call.status === 'running'
  const Icon = toolIcon(call.name)

  return (
    <li className={call.parentToolCallId ? 'ml-6 border-l border-foreground/10 pl-2' : undefined}>
      <button
        aria-expanded={isOpen}
        className="group/step hex-focus flex w-full items-center gap-2.5 rounded-[10px] px-1.5 py-1.5 text-left text-[length:var(--text-secondary)] transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.04]"
        onClick={() => setOpen(!isOpen)}
        type="button"
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-[8px] bg-foreground/[0.05] text-muted">
          <Icon size={13} />
        </span>
        <span className={cn('min-w-0 flex-1 truncate', running ? 'text-foreground' : 'text-muted')}>
          {toolLabel(call)}
        </span>
        {meta ? (
          <span className="shrink-0 text-[length:var(--text-meta)] text-muted">{meta}</span>
        ) : null}
        <StepMark call={call} />
        <ChevronDown
          className={cn(
            'shrink-0 text-muted opacity-0 transition-[opacity,transform] duration-[var(--hex-motion-fast)] group-hover/step:opacity-100',
            isOpen && 'rotate-180 opacity-100'
          )}
          size={12}
        />
      </button>
      {isOpen ? (
        <div className="hex-unfold">
          <div className="mt-1 mb-2 ml-[34px] grid gap-1.5">
            {call.args != null ? (
              <ScrollArea
                className="max-h-40 overflow-hidden rounded-[10px] bg-foreground/[0.04]"
                viewportClassName="overflow-auto"
              >
                <pre className="p-2.5 font-mono text-[length:var(--text-meta)] leading-relaxed">
                  {format(call.args)}
                </pre>
              </ScrollArea>
            ) : null}
            {call.result !== null ? (
              <ScrollArea
                className="max-h-60 overflow-hidden rounded-[10px] bg-foreground/[0.04]"
                viewportClassName="overflow-auto"
              >
                <pre className="p-2.5 font-mono text-[length:var(--text-meta)] leading-relaxed">
                  {format(call.result)}
                </pre>
              </ScrollArea>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** A step still running, other than asking a teammate, which has its own row. */
const stepRunning = (message: Message) =>
  message.toolCalls.some(call => call.status === 'running' && call.name !== ASKING_TOOL)

/**
 * Whether the bot is still at work on this message: it streams, or a step
 * runs after an approval card ended it.
 */
export const isWorking = (message: Message) => message.streaming || stepRunning(message)

/**
 * One status line: the bot's face and what it is doing, in two tones. The
 * specific part ("Taobao" in "Opening Taobao") is drawn stronger than the
 * verb. No bubble behind it, nothing to open, and it does not move; the face
 * beside it does.
 */
export function StatusLine({
  face,
  label,
  name
}: {
  face?: ReactNode
  label: WorkLabel
  name: string
}) {
  return (
    <div
      aria-label={workSentence(name, label)}
      aria-live="polite"
      className="flex h-9 max-w-full items-center gap-2 pr-1 text-[length:var(--text-secondary)] text-muted"
      data-testid="thinking"
      role="status"
    >
      {face}
      <span className="truncate">
        {label.verb}
        {label.object ? <span className="text-foreground/80"> {label.object}</span> : null}
      </span>
    </div>
  )
}

/**
 * The live line at the foot of a running turn. It stays until the whole turn
 * is done: the bot's face, in the mood of its work, and what it is doing
 * right now: "Thinking…", "Opening Taobao", "Searching the web for CER
 * dates", "Typing…". The words come from the running step, never from the
 * model. A page is named by its site and a file by its own name; a command or
 * a script is never quoted. A conversation shows what bots say, not how they
 * got there: the line is gone when the turn is, and the side panel's
 * Computer tab still lists every step.
 */
export function LiveStatus({
  face,
  message,
  name
}: {
  /** The bot's working face; rooms draw their own beside the row and pass none. */
  face?: ReactNode
  message: Message
  name: string
}) {
  // While the bot only waits on a teammate, the ask row under the turn says so.
  if (!stepRunning(message) && asks(message).some(ask => ask.status === 'running')) {
    return null
  }

  return <StatusLine face={face} label={workLabel(message)} name={name} />
}

/**
 * The live status while a turn runs, and nothing after it. `checking` is
 * Auto mode still reviewing a step after an approval card ended the message.
 */
export function WorkStatus({
  checking,
  face,
  message,
  name
}: {
  checking?: string
  face?: ReactNode
  message: Message
  name: string
}) {
  return checking || isWorking(message) ? (
    <LiveStatus face={face} message={message} name={name} />
  ) : null
}
