import { Check, Eye, EyeOff } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Input } from '../../components/ui/input'

/**
 * The card a bot waits on to connect something: a plugin to install, turn
 * on or set up, or a site to sign in to. Its head reads like a contact: the
 * icon, the name, one line, and the action or what happened.
 */
export function ConnectCard({
  action,
  children,
  icon,
  label,
  status,
  subtitle,
  title
}: {
  action?: ReactNode
  children?: ReactNode
  icon: ReactNode
  label: string
  status?: ReactNode
  subtitle?: ReactNode
  title: ReactNode
}) {
  return (
    <div
      aria-label={label}
      className="hex-bubble min-w-0 max-w-[min(85%,24rem)] flex-1 rounded-[18px] border border-border bg-background px-3 py-2.5"
      role="group"
    >
      <div className="flex items-center gap-2.5">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{title}</div>
          {subtitle ? (
            <div className="truncate text-[length:var(--text-secondary)] text-muted">
              {subtitle}
            </div>
          ) : null}
        </div>
        {status ?? action}
      </div>
      {children}
    </div>
  )
}

/** What the user did with a card: done with a check, or declined. */
export function CardStatus({ done, children }: { children: ReactNode; done: boolean }) {
  return done ? (
    <span className="inline-flex shrink-0 items-center gap-1 text-[length:var(--text-secondary)] text-success">
      <Check aria-hidden className="size-3.5" />
      {children}
    </span>
  ) : (
    <span className="shrink-0 text-[length:var(--text-secondary)] text-muted">{children}</span>
  )
}

/** A labelled field for a card; a secret one hides what is typed until asked. */
export function CardField({
  autoComplete,
  autoFocus,
  id,
  label,
  link,
  onChange,
  placeholder,
  secret,
  value
}: {
  autoComplete?: string
  autoFocus?: boolean
  id: string
  label: string
  link?: null | string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
  value: string
}) {
  const [shown, setShown] = useState(false)

  return (
    // The show button sits outside the label, which would otherwise name the field with it.
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-[length:var(--text-secondary)] text-muted" htmlFor={id}>
          {label}
        </label>
        {link ? (
          <a
            className="hex-focus shrink-0 rounded text-[length:var(--text-meta)] text-muted underline-offset-2 hover:text-foreground hover:underline"
            href={link}
            rel="noreferrer"
            target="_blank"
          >
            Get one
          </a>
        ) : null}
      </div>
      <span className="relative">
        <Input
          autoCapitalize="none"
          autoComplete={autoComplete ?? 'off'}
          autoCorrect="off"
          autoFocus={autoFocus}
          className={secret ? 'pr-10' : undefined}
          id={id}
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          type={secret && !shown ? 'password' : 'text'}
          value={value}
        />
        {secret ? (
          <button
            aria-label={shown ? `Hide ${label}` : `Show ${label}`}
            className="hex-focus absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-[8px] text-muted hover:text-foreground"
            onClick={() => setShown(value => !value)}
            type="button"
          >
            {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          </button>
        ) : null}
      </span>
    </div>
  )
}
