import { Check, ChevronDown, CircleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Thinking } from '../../components/ui/thinking'
import { cn } from '../../lib/cn'
import type { Message, ToolCall } from '../../lib/types'

import {
  liveLabel,
  MIN_WORK_S,
  runningLabel,
  toolLabel,
  visibleSteps,
  workShown,
  workSummary
} from './steps'

const format = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

const Dot = () => <span className="hex-pulse size-1.5 shrink-0 rounded-full bg-accent" />

/** One step. Open while it runs so its arguments show live; closed once done. */
function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const running = call.status === 'running'
  const isOpen = open ?? running

  return (
    <li>
      <button
        aria-expanded={isOpen}
        className="flex w-full items-center gap-2 py-1 text-left text-[length:var(--text-secondary)] text-muted hover:text-foreground"
        onClick={() => setOpen(!isOpen)}
        type="button"
      >
        {running ? (
          <Dot />
        ) : call.status === 'error' ? (
          <CircleAlert className="shrink-0 text-danger" size={13} />
        ) : (
          <Check className="shrink-0 text-success" size={13} />
        )}
        <span className="min-w-0 flex-1 truncate">{toolLabel(call)}</span>
        <ChevronDown className={cn('shrink-0', isOpen && 'rotate-180')} size={13} />
      </button>
      {isOpen ? (
        <div className="mb-2 grid gap-2">
          <pre className="max-h-40 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-[length:var(--text-meta)]">
            {format(call.args)}
          </pre>
          {call.result !== null ? (
            <pre className="max-h-60 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-[length:var(--text-meta)]">
              {format(call.result)}
            </pre>
          ) : null}
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
      className="max-h-48 overflow-y-auto whitespace-pre-wrap py-1 text-[length:var(--text-secondary)] text-muted"
      data-testid="thinking-trace"
      ref={box}
    >
      {text}
    </div>
  )
}

/** Re-renders once a streaming turn has run for `MIN_WORK_S`, so the panel can appear. */
function useWorkClock(message: Message): number {
  const [now, setNow] = useState(() => Date.now())
  const due = message.streaming && message.createdAt > 0 ? message.createdAt + MIN_WORK_S * 1000 : 0

  useEffect(() => {
    const wait = due - Date.now()

    if (!due || wait <= 0) {
      return
    }

    const timer = setTimeout(() => setNow(Date.now()), wait)

    return () => clearTimeout(timer)
  }, [due])

  return now
}

/**
 * Sits beside the bot's face, above its bubble, where the work happened. The
 * face is the message's own; this draws only text. While the turn runs: the
 * running step, then after `MIN_WORK_S` a panel with the reasoning trace and
 * each step as it happens, open while the bot thinks or a tool runs.
 * Afterwards: one muted line ("Thought for 12s · 3 steps") that opens into
 * the same panel, or nothing when the work was short or only housekeeping ran.
 */
export function WorkStatus({ message, name }: { message: Message; name: string }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const now = useWorkClock(message)

  // The user's choice lasts for the turn; a finished turn starts collapsed.
  useEffect(() => {
    if (!message.streaming) {
      setOpen(null)
    }
  }, [message.streaming])

  const shown = workShown(message, now)
  const running = runningLabel(message)

  if (!shown) {
    return message.streaming ? (
      <Thinking label={running ?? message.activity} name={name} />
    ) : null
  }

  const working = message.streaming && (Boolean(running) || !message.text)
  const isOpen = open ?? working
  const steps = visibleSteps(message.toolCalls)

  return (
    <div className="hex-fade mt-1 pb-1" data-testid="work-status">
      <div className="flex min-h-6 items-center">
        <button
          aria-expanded={isOpen}
          className="group/steps flex min-w-0 max-w-full items-center gap-1.5 text-[length:var(--text-meta)] text-muted transition-colors hover:text-foreground"
          onClick={() => setOpen(!isOpen)}
          type="button"
        >
          <span className="truncate">
            {message.streaming ? liveLabel(message) : workSummary(message)}
          </span>
          <ChevronDown
            className={cn(
              'shrink-0 opacity-0 transition-opacity group-hover/steps:opacity-100',
              isOpen && 'rotate-180 opacity-100'
            )}
            size={12}
          />
        </button>
      </div>
      {isOpen ? (
        <div className="mt-1 border-l border-foreground/12 pl-3">
          {message.thinking ? <Trace live={message.streaming} text={message.thinking} /> : null}
          {steps.length ? (
            <ul>
              {steps.map(call => (
                <ToolRow call={call} key={call.toolId} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
