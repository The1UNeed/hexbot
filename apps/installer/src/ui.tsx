import { clsx } from 'clsx'
import { Check, Copy, Info } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useEffect, useState } from 'react'

export type Mood = 'happy' | 'idle' | 'listening' | 'sleeping' | 'working'

const HEX =
  'M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z'

/**
 * The pill eyes of the logo (apps/site/src/components/Logo.astro), shaped per
 * mood like the faces in the app: narrowed while working, lowered while it
 * waits on you, smiling when done, shut once Hexbot is gone.
 */
const EYES: Record<Exclude<Mood, 'happy'>, { h: number; y: number }> = {
  idle: { h: 34.8, y: 32.7 },
  listening: { h: 22, y: 44 },
  sleeping: { h: 5, y: 52 },
  working: { h: 24, y: 38 }
}

const EYE_X = [24.3, 60.2]

/** The Hexbot mark. It holds still; its eyes say how the install is going. */
export function Mark({
  className,
  mood = 'idle',
  size = 44
}: {
  className?: string
  mood?: Mood
  size?: number
}) {
  return (
    <svg
      aria-hidden
      className={clsx('shrink-0 text-foreground', className)}
      data-mood={mood}
      height={size}
      viewBox="0 0 100 100"
      width={size}
    >
      <path d={HEX} fill="currentColor" />
      {EYE_X.map(x =>
        mood === 'happy' ? (
          <path
            d={`M${x + 1.5} 54 q6.25 -15 12.5 0`}
            fill="none"
            key={x}
            stroke="var(--hex-background)"
            strokeLinecap="round"
            strokeWidth="9"
          />
        ) : (
          <rect
            fill="var(--hex-background)"
            height={EYES[mood].h}
            key={x}
            rx={Math.min(7.75, EYES[mood].h / 2)}
            width="15.5"
            x={x}
            y={EYES[mood].y}
          />
        )
      )}
    </svg>
  )
}

const VARIANTS = {
  danger: 'bg-danger text-white hover:opacity-90',
  primary: 'bg-foreground text-background hover:opacity-85',
  secondary: 'text-foreground shadow-[inset_0_0_0_1px_var(--hex-border)] hover:bg-surface'
}

export function Button({
  className,
  type = 'button',
  variant = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      className={clsx(
        'inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-[length:var(--text-body)] font-medium whitespace-nowrap transition-[background-color,opacity] duration-100 disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        className
      )}
      type={type}
      {...props}
    />
  )
}

/** A quiet inline action, for the second thing on a screen. */
export function TextButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={clsx(
        'rounded-sm text-foreground underline decoration-border underline-offset-[0.2em] hover:decoration-foreground disabled:opacity-40',
        className
      )}
      type="button"
      {...props}
    />
  )
}

/**
 * Every screen: a drag strip under the macOS traffic lights, the mark and a
 * heading, the body, and a footer whose right side holds the actions.
 */
export function Frame({
  actions,
  aside,
  children,
  mood,
  subtitle,
  title
}: {
  actions?: ReactNode
  aside?: ReactNode
  children?: ReactNode
  mood?: Mood
  subtitle?: ReactNode
  title: string
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="h-11 shrink-0" data-tauri-drag-region />
      <main className="flex min-h-0 flex-1 flex-col px-12">
        <header className="flex items-start gap-5">
          <Mark mood={mood} size={44} />
          <div className="min-w-0 pt-0.5">
            <h1 className="display text-[28px] focus:outline-none" tabIndex={-1}>
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-2 max-w-[36em] text-[15px] leading-snug text-pretty text-muted">
                {subtitle}
              </p>
            ) : null}
          </div>
        </header>
        <div className="-mx-12 mt-7 min-h-0 flex-1 overflow-y-auto px-12 pb-6">{children}</div>
      </main>
      <Footer actions={actions} aside={aside} />
    </div>
  )
}

export function Footer({ actions, aside }: { actions?: ReactNode; aside?: ReactNode }) {
  return (
    <footer className="flex h-[68px] shrink-0 items-center justify-between gap-4 border-t border-border px-12">
      <div className="min-w-0 text-[length:var(--text-secondary)] text-muted">{aside}</div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </footer>
  )
}

/** A quiet note: warnings from the engine, hints, things to know. */
export function Notice({
  children,
  tone = 'quiet'
}: {
  children: ReactNode
  tone?: 'danger' | 'quiet'
}) {
  return (
    <div
      className={clsx(
        'flex items-start gap-2.5 rounded-panel bg-surface px-3.5 py-2.5 text-[length:var(--text-secondary)] leading-snug',
        tone === 'danger' ? 'text-foreground' : 'text-muted'
      )}
      role={tone === 'danger' ? 'alert' : 'note'}
    >
      <Info
        aria-hidden
        className={clsx('mt-px shrink-0', tone === 'danger' ? 'text-danger' : 'text-muted')}
        size={15}
      />
      <div className="selectable min-w-0 break-words">{children}</div>
    </div>
  )
}

export function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }

    const timer = setTimeout(() => setCopied(false), 1500)

    return () => clearTimeout(timer)
  }, [copied])

  return (
    <button
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="inline-grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
      onClick={() => {
        void copyText(text).then(() => setCopied(true))
      }}
      title={copied ? 'Copied' : 'Copy'}
      type="button"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const field = document.createElement('textarea')

    field.value = text
    document.body.append(field)
    field.select()
    document.execCommand('copy')
    field.remove()
  }
}

export function Switch({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label
      className={clsx(
        'inline-flex items-center gap-2.5',
        disabled ? 'opacity-40' : 'cursor-pointer'
      )}
    >
      <button
        aria-checked={checked}
        className={clsx(
          'relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors duration-100',
          checked ? 'bg-foreground' : 'bg-surface-3'
        )}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        role="switch"
        type="button"
      >
        <span
          className={clsx(
            'absolute top-[2px] left-[2px] size-[14px] rounded-full bg-background transition-transform duration-100',
            checked && 'translate-x-[12px]'
          )}
        />
      </button>
      <span>{label}</span>
    </label>
  )
}
