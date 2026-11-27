import {
  Bell,
  CircleAlert,
  CircleHelp,
  Ellipsis,
  type LucideIcon,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../../../components/ui/button'
import { Menu } from '../../../components/ui/menu'
import { cn } from '../../../lib/cn'

import { type Notice, type NoticeTone, sortNotices } from './notice'

const TONES: Record<NoticeTone, { icon: LucideIcon; text: string; wash: string }> = {
  accent: { icon: CircleHelp, text: 'text-accent', wash: 'bg-accent/[0.06]' },
  danger: { icon: CircleAlert, text: 'text-danger', wash: 'bg-danger/[0.06]' },
  info: { icon: Bell, text: 'text-foreground', wash: '' },
  warning: { icon: TriangleAlert, text: 'text-warning', wash: 'bg-warning/[0.06]' }
}

/** What the stack draws: never empty. */
type Notices = [Notice, ...Notice[]]

const iconOf = (notice: Notice) => notice.icon ?? TONES[notice.tone].icon

const roleOf = (notice: Notice) => (notice.tone === 'danger' ? 'alert' : 'status')

function clock(time: number | undefined): null | string {
  return time ? new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
}

const roundButton =
  'hex-focus grid size-6 shrink-0 place-items-center rounded-full text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground'

function Dismiss({ notice, className }: { notice: Notice; className?: string }) {
  return notice.onDismiss ? (
    <button
      aria-label="Dismiss"
      className={cn(roundButton, className)}
      onClick={notice.onDismiss}
      title="Dismiss"
      type="button"
    >
      <X size={14} />
    </button>
  ) : null
}

function More({ notice, className }: { notice: Notice; className?: string }) {
  return notice.menu?.length ? (
    <Menu
      items={notice.menu}
      trigger={
        <button aria-label="More" className={cn(roundButton, className)} type="button">
          <Ellipsis size={14} />
        </button>
      }
    />
  ) : null
}

function Actions({ notice, className }: { notice: Notice; className?: string }) {
  return notice.actions?.length ? (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {notice.actions.map(action => (
        <Button
          className="rounded-full"
          key={action.label}
          onClick={action.onSelect}
          size="sm"
          variant={action.primary ? 'primary' : 'secondary'}
        >
          {action.label}
        </Button>
      ))}
    </div>
  ) : null
}

/**
 * The full card every design opens into: icon, title, time, what happened,
 * and what you can do about it.
 */
function NoticeCard({
  notice,
  className,
  header
}: {
  notice: Notice
  className?: string
  /** Extra controls in the title row, before the time. */
  header?: React.ReactNode
}) {
  const tone = TONES[notice.tone]
  const Icon = iconOf(notice)
  const time = clock(notice.time)

  return (
    <div
      className={cn(
        'hex-glass-strong relative flex flex-col gap-1 overflow-hidden rounded-[18px] py-2.5 pr-2 pl-3.5',
        className
      )}
      data-testid={notice.testId ?? 'notice'}
      data-tone={notice.tone}
      role={roleOf(notice)}
    >
      {tone.wash ? (
        <span
          aria-hidden
          className={cn('pointer-events-none absolute inset-0 -z-[1]', tone.wash)}
        />
      ) : null}
      <div className="flex min-h-6 items-center gap-2">
        <Icon aria-hidden className={cn('shrink-0', tone.text)} size={15} />
        <span className="min-w-0 truncate font-medium">{notice.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {header}
          {time ? (
            <time className="px-1 text-[length:var(--text-meta)] text-muted">{time}</time>
          ) : null}
          <More notice={notice} />
          <Dismiss notice={notice} />
        </span>
      </div>
      {notice.detail ? (
        <p className="pr-2 pl-[23px] text-[length:var(--text-secondary)] break-words text-muted">
          {notice.detail}
        </p>
      ) : null}
      <Actions className="pt-1.5 pb-0.5 pl-[23px]" notice={notice} />
    </div>
  )
}

/** The most urgent card in front, the others peeking out behind it. */
function NoticeStack({ notices }: { notices: Notices }) {
  const [open, setOpen] = useState(false)
  const [front, ...rest] = notices

  // Down to one card, the list closes: the next one arrives stacked.
  useEffect(() => {
    if (!rest.length) {
      setOpen(false)
    }
  }, [rest.length])

  if (open && rest.length) {
    return (
      <div className="hex-fade mx-auto flex max-w-[36rem] flex-col gap-1.5">
        <button
          className="hex-glass hex-glass-press hex-focus mr-1 self-end rounded-full px-3 py-1 text-[length:var(--text-meta)] font-medium text-muted hover:text-foreground"
          onClick={() => setOpen(false)}
          type="button"
        >
          Show less
        </button>
        {notices.map(notice => (
          <NoticeCard key={notice.id} notice={notice} />
        ))}
      </div>
    )
  }

  const layers = Math.min(rest.length, 2)

  return (
    <div className="relative mx-auto max-w-[36rem]" style={{ paddingTop: layers * 7 }}>
      {Array.from({ length: layers }, (_, layer) => (
        <div
          aria-hidden
          className="absolute rounded-[18px] border border-border bg-surface shadow-[var(--hex-card-shadow)]"
          key={layer}
          style={{
            bottom: (layer + 1) * 7,
            left: (layer + 1) * 12,
            right: (layer + 1) * 12,
            top: (layers - layer - 1) * 7,
            zIndex: 1 - layer
          }}
        />
      ))}
      <NoticeCard
        className="z-[2]"
        header={
          rest.length ? (
            <button
              className="hex-focus mr-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[length:var(--text-meta)] font-medium text-muted hover:text-foreground"
              onClick={() => setOpen(true)}
              type="button"
            >
              {rest.length} more
            </button>
          ) : null
        }
        key={front.id}
        notice={front}
      />
    </div>
  )
}

/**
 * The one place a chat shows notices: just above the composer. The most
 * urgent card is in front and the others peek out behind it; "N more" lists
 * them all.
 */
export function NoticeDock({ notices }: { notices: Notice[] }) {
  const [first, ...rest] = sortNotices(notices)

  if (!first) {
    return null
  }

  return (
    <section aria-label="Notices" className="relative mb-2" data-testid="notice-dock">
      <NoticeStack notices={[first, ...rest]} />
    </section>
  )
}
