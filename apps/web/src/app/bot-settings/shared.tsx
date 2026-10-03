import { Check } from 'lucide-react'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { AvatarBuilder } from '../../components/ui/avatar-builder'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { avatarPng, avatarSrc, type AvatarStyle, styleForName } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { Bot, BotUpdatePatch } from '../../lib/types'

/** One grouped-list card: white over the glass, rows divided by hairlines. */
export const cardClass = 'hex-card rounded-2xl'
/** The hairline between rows in a card. */
export const dividerClass = 'divide-y divide-foreground/[0.07]'
export const fieldLabel = 'mb-1.5 block text-[length:var(--text-secondary)] text-muted'
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export type SaveBot = (patch: BotUpdatePatch) => Promise<void> | void

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** Page title plus one line saying what the page is for. */
export function Heading({
  children,
  description
}: {
  children: React.ReactNode
  description?: string
}) {
  return (
    <header className="mb-6">
      <h2 className="text-[length:var(--text-title)] font-semibold tracking-[-0.01em]">
        {children}
      </h2>
      {description ? (
        <p className="mt-1 text-[length:var(--text-secondary)] text-muted">{description}</p>
      ) : null}
    </header>
  )
}

/** A muted group label over one card of rows. */
export function Group({
  action,
  children,
  className,
  footer,
  title
}: {
  /** Sits at the right of the label: a small button or two. */
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** One short muted line under the card. */
  footer?: React.ReactNode
  title?: string
}) {
  return (
    <div className={className}>
      {title || action ? (
        <div className="mb-2 flex min-h-5 items-center justify-between gap-3 px-1">
          {title ? (
            <p className="text-[length:var(--text-meta)] font-medium text-muted">{title}</p>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      <div className={cn(cardClass, dividerClass)}>{children}</div>
      {footer ? (
        <p className="mt-2 px-1 text-[length:var(--text-meta)] text-muted">{footer}</p>
      ) : null}
    </div>
  )
}

/** One row: title, optional second line, and a control on the right. */
export function Row({
  children,
  className,
  control,
  description,
  title
}: {
  children?: React.ReactNode
  className?: string
  control?: React.ReactNode
  description?: React.ReactNode
  title: React.ReactNode
}) {
  return (
    <div className={cn('flex min-h-[52px] items-center gap-4 px-4 py-2.5', className)}>
      <div className="min-w-0 flex-1">
        <div className="text-[length:var(--text-body)]">{title}</div>
        {description ? (
          <div className="mt-0.5 text-[length:var(--text-secondary)] text-muted">{description}</div>
        ) : null}
        {children}
      </div>
      {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
    </div>
  )
}

/**
 * One row that is a choice in a list: a title, a line under it and a check
 * when chosen. Put the rows in a `role="radiogroup"`; like native radios,
 * only the chosen row takes Tab and the arrow keys move the choice.
 */
export function ChoiceRow({
  checked,
  description,
  onSelect,
  title
}: {
  checked: boolean
  description?: React.ReactNode
  onSelect: () => void
  title: React.ReactNode
}) {
  return (
    <button
      aria-checked={checked}
      className="flex min-h-[52px] w-full items-center gap-4 px-4 py-2.5 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04]"
      onClick={onSelect}
      onKeyDown={event => {
        const step = { ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1 }[event.key]
        const group = event.currentTarget.closest('[role="radiogroup"]')

        if (!step || !group) {
          return
        }

        event.preventDefault()
        const rows = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        const next = rows[(rows.indexOf(event.currentTarget) + step + rows.length) % rows.length]
        next?.focus()
        next?.click()
      }}
      role="radio"
      tabIndex={checked ? 0 : -1}
      type="button"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[length:var(--text-body)]">{title}</span>
        {description ? (
          <span className="mt-0.5 block text-[length:var(--text-secondary)] text-muted">
            {description}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full transition-colors',
          checked ? 'bg-foreground text-background' : 'bg-foreground/[0.08]'
        )}
      >
        {checked ? <Check size={12} strokeWidth={3} /> : null}
      </span>
    </button>
  )
}

/** A label on the left, a bare field on the right, inside a card row. */
export const rowFieldClass =
  'h-auto min-h-[36px] rounded-none bg-transparent px-0 py-0 hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0'

export function FieldRow({
  children,
  label,
  top = false
}: {
  children: React.ReactNode
  label: React.ReactNode
  /** Keep the label at the top, for a field with several lines. */
  top?: boolean
}) {
  return (
    <label
      className={cn(
        'grid min-h-[52px] grid-cols-[112px_1fr] gap-4 px-4 py-2',
        top ? 'items-start' : 'items-center'
      )}
    >
      <span className={cn('text-[length:var(--text-body)] text-muted', top && 'pt-2')}>
        {label}
      </span>
      <span className="min-w-0">{children}</span>
    </label>
  )
}

interface InlineFieldProps {
  ariaLabel: string
  className?: string
  multiline?: boolean
  onSave: (value: string) => void
  placeholder?: string
  value: string
}

/** A field that saves on blur when its text changed. */
export function InlineField({
  ariaLabel,
  className,
  multiline = false,
  onSave,
  placeholder,
  value
}: InlineFieldProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const props = {
    'aria-label': ariaLabel,
    className,
    onBlur: () => {
      if (draft !== value) {
        onSave(draft)
      }
    },
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(event.target.value),
    placeholder,
    value: draft
  }

  return multiline ? <Textarea {...props} /> : <Input {...props} />
}

/** The large face with the Bot / Upload picker under it. */
export function AvatarPicker({
  bot,
  hint = true,
  onSave
}: {
  bot: Bot
  /** The one-line prompt under the face; off where the name sits right under it. */
  hint?: boolean
  onSave: SaveBot
}) {
  const [picking, setPicking] = useState(false)
  const [pickerTab, setPickerTab] = useState<'bot' | 'upload'>('bot')
  const [style, setStyle] = useState<AvatarStyle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const currentStyle = style ?? styleForName(bot.display_name)

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      return setError('Choose a PNG, JPEG, or WebP image.')
    }

    if (file.size > MAX_AVATAR_BYTES) {
      return setError('Avatar must be 2 MB or smaller.')
    }

    const reader = new FileReader()
    reader.onload = () => void onSave({ avatar: String(reader.result) })
    reader.onerror = () => setError('Could not read that image.')
    reader.readAsDataURL(file)
  }

  const chooseFace = (next: AvatarStyle) => {
    setStyle(next)
    void avatarPng(next).then(png => {
      if (png) {
        void onSave({ avatar: png })
      }
    })
  }

  return (
    <div>
      <div className="flex flex-col items-center gap-2">
        <button
          aria-expanded={picking}
          aria-label="Change avatar"
          className="hex-face rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          onClick={() => setPicking(value => !value)}
          type="button"
        >
          <Avatar
            image={avatarSrc(bot.avatar)}
            name={bot.display_name}
            size="xl"
            style={currentStyle}
          />
        </button>
        {hint ? (
          <span className="text-[length:var(--text-meta)] text-muted">
            {picking ? 'Pick a face or upload one' : 'Click the face to change it'}
          </span>
        ) : null}
        <input
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={upload}
          ref={fileRef}
          type="file"
        />
      </div>
      {picking ? (
        <div className={cn(cardClass, 'hex-bubble mt-4')}>
          <div className="flex gap-1 px-3 pt-3" role="tablist">
            {(
              [
                ['bot', 'Bot'],
                ['upload', 'Upload']
              ] as const
            ).map(([id, label]) => (
              <button
                aria-selected={pickerTab === id}
                className={cn(
                  'h-7 rounded-full px-3 text-[length:var(--text-secondary)] transition-colors',
                  pickerTab === id
                    ? 'bg-foreground text-background'
                    : 'text-muted hover:bg-foreground/[0.06] hover:text-foreground'
                )}
                key={id}
                onClick={() => setPickerTab(id)}
                role="tab"
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="p-3">
            {pickerTab === 'bot' ? (
              <AvatarBuilder onChange={chooseFace} preview={false} value={currentStyle} />
            ) : (
              <div className="grid justify-items-center gap-2 py-2 text-center">
                <p className="text-[length:var(--text-secondary)] text-muted">
                  PNG, JPEG or WebP up to 2 MB.
                </p>
                <Button onClick={() => fileRef.current?.click()} variant="secondary">
                  Choose image
                </Button>
                {bot.avatar ? (
                  <Button onClick={() => void onSave({ avatar: null })} variant="ghost">
                    Use a generated face
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
      {error ? (
        <p
          className="mt-2 text-center text-[length:var(--text-secondary)] text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Name, Label and Description as rows of one card. Shared by the panel and Profile. */
export function IdentityFields({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  return (
    <div className={cn(cardClass, dividerClass)}>
      <FieldRow label="Name">
        <InlineField
          ariaLabel="Bot name"
          className={rowFieldClass}
          onSave={value => onSave({ display_name: value })}
          value={bot.display_name}
        />
      </FieldRow>
      <FieldRow label="Label">
        <InlineField
          ariaLabel="Title"
          className={rowFieldClass}
          onSave={value => onSave({ title: value })}
          placeholder="Research, marketing, admin"
          value={bot.title}
        />
      </FieldRow>
      <FieldRow label="Description" top>
        <InlineField
          ariaLabel="Description"
          className={cn(rowFieldClass, 'py-2 leading-normal')}
          multiline
          onSave={value => onSave({ description: value })}
          placeholder="What this bot is for"
          value={bot.description}
        />
        <span className="mb-1 block text-[length:var(--text-meta)] text-muted">
          Other bots read this to decide when to ask {bot.display_name} for help. Leave it blank and
          Hexbot writes one for them.
        </span>
      </FieldRow>
    </div>
  )
}

export function formatTimestamp(value: null | number | undefined): string {
  return value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleString() : 'Never'
}
