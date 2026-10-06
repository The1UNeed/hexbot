import {
  AudioLines,
  Brain,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Code,
  Eye,
  FilePen,
  FileText,
  FolderSearch,
  Globe,
  Image,
  ListTodo,
  type LucideIcon,
  MousePointer2,
  Sparkles,
  SquareTerminal,
  Users,
  Wrench
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { cn } from '../../lib/cn'
import type { Message, ToolCall } from '../../lib/types'
import { uiActions } from '../../stores/ui'

import { asks, liveStatus, toolLabel, visibleSteps, workShown, workSummary } from './steps'

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
              <pre className="max-h-40 overflow-auto rounded-[10px] bg-foreground/[0.04] p-2.5 font-mono text-[length:var(--text-meta)] leading-relaxed">
                {format(call.args)}
              </pre>
            ) : null}
            {call.result !== null ? (
              <pre className="max-h-60 overflow-auto rounded-[10px] bg-foreground/[0.04] p-2.5 font-mono text-[length:var(--text-meta)] leading-relaxed">
                {format(call.result)}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** The reasoning trace; follows the newest line while it streams. */
function Trace({ live, text }: { live: boolean; text: string }) {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (live && box.current) {
      box.current.scrollTop = box.current.scrollHeight
    }
  }, [live, text])

  return (
    <div
      className="max-h-56 overflow-y-auto whitespace-pre-wrap px-1.5 text-[length:var(--text-secondary)] leading-relaxed text-muted"
      data-testid="thinking-trace"
      ref={box}
    >
      {text}
    </div>
  )
}

/**
 * The rounded card a status opens into: the reasoning trace, then each step.
 * While the turn runs it stays open until the turn ends. In a bot's own chat
 * a link at the foot opens the same steps in the panel's Computer tab; rooms
 * have no panel and pass `computer` false. It unfolds into the column, so
 * what sits under it slides down rather than jumping.
 */
function WorkCard({ computer, message }: { computer: boolean; message: Message }) {
  const steps = visibleSteps(message.toolCalls)

  return (
    <div className="hex-unfold w-[min(34rem,100%)]">
      <div
        className="mt-1 ml-3 grid min-w-0 gap-2 border-l-2 border-foreground/[0.08] py-1 pl-2"
        data-testid="work-status"
      >
        {message.thinking ? (
          <Trace live={message.streaming} text={message.thinking} />
        ) : message.streaming && !steps.length ? (
          <p className="px-1.5 text-[length:var(--text-secondary)] text-muted">
            Nothing to show yet.
          </p>
        ) : null}
        {steps.length ? (
          <ul
            className={cn(
              'min-w-0',
              message.thinking && 'border-t border-foreground/[0.06] pt-1.5'
            )}
          >
            {steps.map(call => (
              <StepRow call={call} key={call.toolId} />
            ))}
          </ul>
        ) : null}
        {computer && steps.length ? (
          <button
            className="hex-focus flex items-center gap-1 justify-self-start rounded-full px-1.5 text-[length:var(--text-meta)] text-muted transition-colors hover:text-foreground"
            onClick={() => uiActions().openPanel('computer')}
            type="button"
          >
            Open in Computer
            <ChevronRight size={12} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The live line at the foot of a running turn. It stays until the whole turn
 * is done: the bot's bobbing face and muted words, no bubble behind them
 * ("General is working", "General is running a command"). Click it for the
 * trace and the steps. When the turn ends the line for what it did takes its
 * place at once.
 */
export function LiveStatus({
  computer = false,
  face,
  message,
  name
}: {
  /** Whether the work card may open the side panel's Computer tab. */
  computer?: boolean
  /** The bot's working face; rooms draw their own beside the row and pass none. */
  face?: ReactNode
  message: Message
  name: string
}) {
  const [open, setOpen] = useState(false)
  const status = liveStatus(message, name)

  // While the bot only waits on a teammate, the ask row under the turn says so.
  if (!status.call && asks(message).some(ask => ask.status === 'running')) {
    return null
  }

  // Only the short line is a live region; the card's streaming trace would
  // otherwise be read out again on every update.
  return (
    <div className="flex flex-col items-start">
      <div
        aria-label={status.label}
        aria-live="polite"
        className="flex max-w-full"
        data-testid="thinking"
        role="status"
      >
        <button
          aria-expanded={open}
          className="group/live hex-focus flex h-9 max-w-full items-center gap-2 rounded-full pr-1 text-[length:var(--text-secondary)] text-muted transition-colors duration-[var(--hex-motion-fast)] hover:text-foreground"
          onClick={() => setOpen(!open)}
          type="button"
        >
          {face}
          <span className="hex-fade truncate" key={status.label}>
            {status.label}
          </span>
          <ChevronDown
            className={cn(
              'shrink-0 opacity-0 transition-[opacity,transform] duration-[var(--hex-motion-fast)] group-hover/live:opacity-100',
              open && 'rotate-180 opacity-100'
            )}
            size={12}
          />
        </button>
      </div>
      {open ? <WorkCard computer={computer} message={message} /> : null}
    </div>
  )
}

/**
 * What a turn did, at its foot under its messages, where the live status
 * was. While the turn runs it is nothing; afterwards one muted line
 * ("Thought for 12s") that opens into the work card, or nothing when the
 * work was short or only housekeeping ran. A line for a turn that just ended
 * fades in (`fresh`); restored history is drawn in place.
 */
export function WorkSummary({
  computer = false,
  fresh = false,
  message,
  name
}: {
  computer?: boolean
  fresh?: boolean
  message: Message
  name?: string
}) {
  const [open, setOpen] = useState(false)

  if (message.streaming || !workShown(message)) {
    return null
  }

  return (
    <div className={cn('flex flex-col items-start', fresh && 'hex-fade')}>
      <button
        aria-expanded={open}
        className="group/steps hex-focus flex min-h-6 max-w-full items-center gap-1 rounded-full px-1 text-[length:var(--text-meta)] text-muted transition-colors duration-[var(--hex-motion-fast)] hover:text-foreground"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="truncate">{workSummary(message, name)}</span>
        <ChevronRight
          className={cn(
            'shrink-0 transition-transform duration-[var(--hex-motion-fast)]',
            open && 'rotate-90'
          )}
          size={12}
        />
      </button>
      {open ? <WorkCard computer={computer} message={message} /> : null}
    </div>
  )
}

/** The live status while a turn runs, the summary line after it. */
export function WorkStatus({
  face,
  message,
  name
}: {
  face?: ReactNode
  message: Message
  name: string
}) {
  return message.streaming ? (
    <LiveStatus face={face} message={message} name={name} />
  ) : (
    <WorkSummary message={message} name={name} />
  )
}
