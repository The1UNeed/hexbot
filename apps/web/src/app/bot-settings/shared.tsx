import { type ChangeEvent, useEffect, useRef, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { AvatarBuilder } from '../../components/ui/avatar-builder'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { avatarPng, avatarSrc, type AvatarStyle, styleForName } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import type { Bot, BotUpdatePatch } from '../../lib/types'

export const cardClass = 'rounded-panel bg-surface-2/70'
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
  description: string
}) {
  return (
    <header className="mb-5">
      <h2 className="text-[length:var(--text-title)] font-semibold">{children}</h2>
      <p className="mt-1 text-muted">{description}</p>
    </header>
  )
}

/** A muted group label over one card of rows. */
export function Group({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div>
      <p className="mb-2 pl-0.5 text-[length:var(--text-secondary)] text-muted">{title}</p>
      <div className={cn(cardClass, 'divide-y divide-border')}>{children}</div>
    </div>
  )
}

/** One row: title, optional second line, and a control on the right. */
export function Row({
  children,
  control,
  description,
  title
}: {
  children?: React.ReactNode
  control?: React.ReactNode
  description?: React.ReactNode
  title: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {description ? (
          <div className="text-[length:var(--text-secondary)] text-muted">{description}</div>
        ) : null}
        {children}
      </div>
      {control}
    </div>
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
export function AvatarPicker({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
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
      <div className="flex flex-col items-center">
        <button
          aria-expanded={picking}
          aria-label="Change avatar"
          className="hex-face rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-foreground/40"
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
        <input
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={upload}
          ref={fileRef}
          type="file"
        />
      </div>
      {picking ? (
        <div className={cn(cardClass, 'hex-bubble mt-4 border border-border')}>
          <div className="flex gap-1 border-b border-border px-2 py-2" role="tablist">
            {(
              [
                ['bot', 'Bot'],
                ['upload', 'Upload']
              ] as const
            ).map(([id, label]) => (
              <button
                aria-selected={pickerTab === id}
                className={cn(
                  'rounded-control px-2.5 py-1 text-[length:var(--text-secondary)] transition-colors',
                  pickerTab === id ? 'bg-surface-3 text-foreground' : 'text-muted hover:text-foreground'
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
              <div className="grid gap-2 text-center">
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
        <p className="mt-2 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Name, Label and Description, saved on blur. Shared by the panel and Profile. */
export function IdentityFields({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  return (
    <div className="grid gap-3">
      <label className="block">
        <span className={fieldLabel}>Name</span>
        <InlineField
          ariaLabel="Bot name"
          onSave={value => onSave({ display_name: value })}
          value={bot.display_name}
        />
      </label>
      <label className="block">
        <span className={fieldLabel}>Label (optional)</span>
        <InlineField
          ariaLabel="Title"
          onSave={value => onSave({ title: value })}
          placeholder="Research, marketing, admin"
          value={bot.title}
        />
      </label>
      <label className="block">
        <span className={fieldLabel}>Description</span>
        <InlineField
          ariaLabel="Description"
          multiline
          onSave={value => onSave({ description: value })}
          placeholder="What this bot is for"
          value={bot.description}
        />
      </label>
    </div>
  )
}

export function formatTimestamp(value: null | number | undefined): string {
  return value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleString() : 'Never'
}
