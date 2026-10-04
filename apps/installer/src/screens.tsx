import { clsx } from 'clsx'
import { ChevronRight } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useRef } from 'react'

import type { Detection, InstallOption } from './api'
import {
  formatSize,
  friendlyError,
  OPTION_NAME,
  OPTION_SUMMARY,
  OPTIONS,
  stageLabel,
  tildify,
  TRACK_NAME
} from './copy'
import { OptionIllustration } from './illustrations'
import type { Job, Screen } from './machine'
import { Button, Footer, Frame, Mark, Notice } from './ui'

export function Loading() {
  return <div className="h-full" data-tauri-drag-region />
}

export function Unsupported({ detection, onQuit }: { detection: Detection; onQuit: () => void }) {
  return (
    <Frame
      actions={
        <Button data-primary onClick={onQuit} variant="primary">
          Quit
        </Button>
      }
      mood="listening"
      subtitle={`Hexbot runs on macOS (Apple silicon and Intel) and on Linux (x86_64). This computer is ${detection.platform}.`}
      title="Hexbot is not available for this computer"
    />
  )
}

export function Welcome({ detection, onBegin }: { detection: Detection; onBegin: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="h-11 shrink-0" data-tauri-drag-region />
      <main className="flex flex-1 flex-col items-center justify-center px-16 pb-6 text-center">
        <Mark size={88} />
        <h1 className="display mt-8 text-[40px] focus:outline-none" tabIndex={-1}>
          Welcome to Hexbot
        </h1>
        <p className="mt-4 max-w-[30em] text-[16px] leading-relaxed text-pretty text-muted">
          Self-hosted bots with faces, names, and a memory of their own. Choose how Hexbot runs on
          this computer; the installer downloads only what that option needs.
        </p>
        {detection.daemonFiles && detection.locations ? (
          <p className="mt-4 text-muted">
            Hexbot daemon files were found in {tildify(detection.locations.hexbotHome, detection.locations.home)}. Your data stays.
          </p>
        ) : null}
      </main>
      <Footer
        actions={
          <Button data-primary onClick={onBegin} variant="primary">
            Continue
          </Button>
        }
        aside={`Hexbot Installer ${detection.installerVersion}`}
      />
    </div>
  )
}

export function Installed({
  detection,
  onChange,
  onQuit,
  onRepair,
  onUninstall
}: {
  detection: Detection
  onChange: () => void
  onQuit: () => void
  onRepair: () => void
  onUninstall: () => void
}) {
  const installed = detection.installed!

  if (installed.apps.some(app => app.managed_by_dpkg)) {
    return (
      <Frame actions={<Button data-primary onClick={onQuit}>Quit</Button>} title="Hexbot is installed">
        <Notice>
          Hexbot was installed with your package manager. Update it with apt, or remove it with
          sudo apt remove hexbot, then run this installer again. Your Hexbot data will be kept.
        </Notice>
      </Frame>
    )
  }

  const name = OPTION_NAME[installed.option]
  const track = installed.track ? TRACK_NAME[installed.track] : null

  const actions: { description: string; label: string; onClick: () => void; primary?: boolean }[] =
    [
      {
        description: track
          ? `Download the latest ${track} release of Hexbot ${name} and reinstall it. Your Hexbot data stays.`
          : `Download the latest release of Hexbot ${name} and reinstall it. Your Hexbot data stays.`,
        label: 'Update or repair',
        onClick: onRepair,
        primary: true
      },
      {
        description: `Switch to ${OPTIONS.filter(option => option !== installed.option)
          .map(option => OPTION_NAME[option])
          .join(' or ')}. Your Hexbot data stays.`,
        label: 'Change',
        onClick: onChange
      },
      { description: 'Remove Hexbot from this computer.', label: 'Uninstall', onClick: onUninstall }
    ]

  return (
    <Frame
      actions={<Button onClick={onQuit}>Quit</Button>}
      aside={`Hexbot Installer ${detection.installerVersion}`}
      subtitle={
        installed.version ? (
          <span className="selectable">
            {track ? `${track} ` : ''}
            {installed.version}
          </span>
        ) : (
          'Found on this computer.'
        )
      }
      title={`Hexbot ${name} is installed`}
    >
      <ul className="divide-y divide-border border-y border-border">
        {actions.map(action => (
          <li key={action.label}>
            <button
              className="group -mx-3 flex w-[calc(100%+1.5rem)] items-center gap-4 rounded-control px-3 py-3.5 text-left hover:bg-surface"
              data-primary={action.primary ? '' : undefined}
              onClick={action.onClick}
              type="button"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">{action.label}</span>
                <span className="mt-0.5 block text-[length:var(--text-secondary)] text-muted">
                  {action.description}
                </span>
              </span>
              <ChevronRight
                aria-hidden
                className="shrink-0 text-muted group-hover:text-foreground"
                size={16}
              />
            </button>
          </li>
        ))}
      </ul>
    </Frame>
  )
}

export function Choose({
  detection,
  onBack,
  onNext,
  onSelect,
  selected
}: {
  detection: Detection
  onBack: () => void
  onNext: () => void
  onSelect: (option: InstallOption) => void
  selected: InstallOption | null
}) {
  const current = detection.installed?.option ?? null
  const choices = OPTIONS.filter(option => option !== current)
  const cards = useRef(new Map<InstallOption, HTMLDivElement>())

  const move = (step: number) => {
    const index = selected ? choices.indexOf(selected) : step > 0 ? -1 : 0
    const option = choices[(index + step + choices.length) % choices.length]!

    onSelect(option)
    cards.current.get(option)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, option: InstallOption) => {
    if (option === current) {
      return
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === ' ') {
      event.preventDefault()
      onSelect(option)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onSelect(option)
      onNext()
    }
  }

  return (
    <Frame
      actions={
        <>
          <Button onClick={onBack}>Back</Button>
          <Button data-primary disabled={!selected} onClick={onNext} variant="primary">
            Continue
          </Button>
        </>
      }
      subtitle={
        current
          ? `Hexbot ${OPTION_NAME[current]} is installed. Your Hexbot data stays where it is.`
          : 'You can change this later by running the installer again.'
      }
      title={current ? 'Change to another option' : 'How do you want to use Hexbot?'}
    >
      <div aria-label="Install option" className="grid grid-cols-3 gap-3" role="radiogroup">
        {OPTIONS.map(option => {
          const checked = selected === option
          const disabled = option === current
          const focusable = checked || (!selected && option === choices[0])

          return (
            <div
              aria-checked={checked}
              aria-describedby={`${option}-summary`}
              aria-disabled={disabled || undefined}
              aria-labelledby={`${option}-name`}
              className={clsx(
                'relative flex flex-col rounded-panel p-4 pt-5 outline-offset-2 transition-shadow duration-100',
                disabled
                  ? 'opacity-50 shadow-[inset_0_0_0_1px_var(--hex-border)]'
                  : checked
                    ? 'bg-surface shadow-[inset_0_0_0_2px_var(--hex-text)]'
                    : 'cursor-pointer shadow-[inset_0_0_0_1px_var(--hex-border)] hover:bg-surface'
              )}
              key={option}
              onClick={() => !disabled && onSelect(option)}
              onDoubleClick={() => {
                if (!disabled) {
                  onSelect(option)
                  onNext()
                }
              }}
              onKeyDown={event => onKeyDown(event, option)}
              ref={element => {
                if (element) {
                  cards.current.set(option, element)
                }
              }}
              role="radio"
              tabIndex={focusable && !disabled ? 0 : -1}
            >
              <span
                aria-hidden
                className={clsx(
                  'absolute top-3.5 right-3.5 grid size-4 place-items-center rounded-full',
                  checked ? 'bg-foreground' : 'shadow-[inset_0_0_0_1.5px_var(--hex-border)]'
                )}
              >
                {checked ? <span className="size-1.5 rounded-full bg-background" /> : null}
              </span>
              <OptionIllustration option={option} />
              <span className="mt-4 flex items-center gap-2">
                <span className="text-[16px] font-semibold" id={`${option}-name`}>
                  {OPTION_NAME[option]}
                </span>
                {disabled ? (
                  <span className="rounded-full bg-surface-2 px-2 py-px text-[11px] font-medium text-muted">
                    Installed
                  </span>
                ) : null}
              </span>
              <span
                className="mt-1 text-[length:var(--text-secondary)] leading-snug text-muted"
                id={`${option}-summary`}
              >
                {OPTION_SUMMARY[option]}
              </span>
            </div>
          )
        })}
      </div>
    </Frame>
  )
}

export function Uninstall({
  detection,
  onBack,
  onToggle,
  onUninstall,
  removeData
}: {
  detection: Detection
  onBack: () => void
  onToggle: () => void
  onUninstall: () => void
  removeData: boolean
}) {
  const installed = detection.installed!
  const locations = detection.locations!
  const data = tildify(locations.hexbotHome, locations.home)

  const removed = [
    ...installed.apps.map(app => tildify(app.path, locations.home)),
    detection.daemonFiles || installed.option !== 'client'
      ? `The daemon runtime in ${data}/runtime`
      : null,
    installed.option === 'headless'
      ? 'The daemon, its background service, and the hexbot command'
      : installed.service
        ? 'The daemon service'
        : null
  ].filter(item => item !== null)

  return (
    <Frame
      actions={
        <>
          <Button onClick={onBack}>Cancel</Button>
          <Button onClick={onUninstall} variant="danger">
            {removeData ? 'Uninstall and delete data' : 'Uninstall'}
          </Button>
        </>
      }
      mood="listening"
      subtitle="Your Hexbot data stays unless you choose to delete it."
      title={`Uninstall Hexbot ${OPTION_NAME[installed.option]}?`}
    >
      <p className="text-muted">This removes</p>
      <ul className="mt-2 space-y-1 text-[15px]">
        {removed.map(item => (
          <li className="selectable flex gap-2.5" key={item}>
            <span aria-hidden className="text-muted">
              –
            </span>
            {item}
          </li>
        ))}
      </ul>
      <label className="mt-7 flex cursor-pointer items-start gap-3 rounded-panel p-3.5 shadow-[inset_0_0_0_1px_var(--hex-border)]">
        <input
          checked={removeData}
          className="mt-[3px] size-4 shrink-0 accent-[var(--hex-danger)]"
          onChange={onToggle}
          type="checkbox"
        />
        <span>
          <span className="block font-medium">Also delete my Hexbot data</span>
          <span className="mt-0.5 block text-[length:var(--text-secondary)] text-muted">
            Bots, rooms, memory, and settings in <span className="selectable">{data}</span>.{' '}
            {removeData ? (
              <span className="text-danger">This cannot be undone.</span>
            ) : (
              'Leave this off to keep them for a later install.'
            )}
          </span>
        </span>
      </label>
    </Frame>
  )
}

export function jobTitle(job: Job): string {
  switch (job.kind) {
    case 'install':
      return job.from
        ? `Changing to Hexbot ${OPTION_NAME[job.option]}`
        : `Installing Hexbot ${OPTION_NAME[job.option]}`

    case 'repair':
      return `Updating Hexbot ${OPTION_NAME[job.option]}`

    case 'uninstall':
      return 'Uninstalling Hexbot'
  }
}

/** True when a job's `service` stage takes the daemon service away rather than starting it. */
function removesService(job: Job): boolean {
  return job.kind === 'uninstall' || (job.kind === 'install' && job.option === 'client')
}

export function Working({
  data,
  screen
}: {
  data: string
  screen: Extract<Screen, { name: 'working' }>
}) {
  const { job, last, percent } = screen
  const download = last?.stage === 'download' && last.total ? last : null

  const label = last
    ? stageLabel(last, removesService(job))
    : job.kind === 'uninstall'
      ? 'Starting'
      : 'Checking the latest release'

  const detail = download
    ? `${formatSize(download.downloaded ?? 0)} of ${formatSize(download.total ?? 0)}`
    : last && stageLabel(last, removesService(job)) !== last.message.replace(/\.$/, '')
      ? last.message
      : ''

  return (
    <Frame
      mood="working"
      subtitle={
        job.kind !== 'uninstall'
          ? 'Keep this window open until it finishes.'
          : job.removeData
            ? `Your Hexbot data in ${data} is deleted too.`
            : `Your Hexbot data stays in ${data}.`
      }
      title={jobTitle(job)}
    >
      <div className="pt-10">
        {percent !== null ? (
          <div
            aria-label="Progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}
        <div className="mt-4 flex items-baseline justify-between gap-4">
          <p aria-live="polite" className="min-w-0 truncate text-[15px] font-medium" role="status">
            {label}
          </p>
          {percent !== null ? (
            <p className="shrink-0 text-[length:var(--text-secondary)] text-muted tabular-nums">
              {percent}%
            </p>
          ) : null}
        </div>
        <p className="selectable mt-1 h-[1.5em] truncate font-mono text-[length:var(--text-meta)] text-muted">
          {detail}
        </p>
      </div>
    </Frame>
  )
}

function errorTitle(job: Job | null): string {
  if (!job) {
    return 'The installer could not check this computer'
  }

  switch (job.kind) {
    case 'install':
      return job.from
        ? `Hexbot was not changed to ${OPTION_NAME[job.option]}`
        : `Hexbot ${OPTION_NAME[job.option]} was not installed`

    case 'repair':
      return 'The update did not finish'

    case 'uninstall':
      return 'Hexbot was not uninstalled'
  }
}

export function ErrorScreen({
  canGoBack,
  job,
  message,
  onBack,
  onRetry
}: {
  canGoBack: boolean
  job: Job | null
  message: string
  onBack: () => void
  onRetry: () => void
}) {
  const friendly = friendlyError(message)

  return (
    <Frame
      actions={
        <>
          {canGoBack ? <Button onClick={onBack}>Back</Button> : null}
          <Button data-primary={job?.kind === 'uninstall' ? undefined : true} onClick={onRetry} variant="primary">
            Try again
          </Button>
        </>
      }
      mood="listening"
      title={errorTitle(job)}
    >
      <Notice tone="danger">{friendly.message}</Notice>
      {friendly.detail ? (
        <details className="mt-4 text-[length:var(--text-secondary)] text-muted">
          <summary className="cursor-pointer rounded-sm">Details</summary>
          <p className="selectable mt-2 font-mono text-[length:var(--text-meta)] break-words">
            {friendly.detail}
          </p>
        </details>
      ) : null}
    </Frame>
  )
}
