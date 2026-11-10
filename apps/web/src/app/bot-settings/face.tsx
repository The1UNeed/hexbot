import { type ChangeEvent, useRef, useState } from 'react'

import { Avatar, useFaceRead } from '../../components/ui/avatar'
import { FaceChoices } from '../../components/ui/avatar-builder'
import { Button } from '../../components/ui/button'
import {
  avatarPng,
  type AvatarStyle,
  botFace,
  randomStyle,
  resolveStyle,
  styleForName
} from '../../lib/avatar-builder'
import type { Bot } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { botBubbleStyle } from '../conversation'

import { Heading, type SaveBot } from './shared'

const MAX_PHOTO_BYTES = 2 * 1024 * 1024

/**
 * The bot as it will look: its face or photo, large, on a stage washed with
 * the face colour, over a sample of the bubble its messages get. A photo
 * keeps the plain stage and bubble, as it does in a chat.
 */
function FaceStage({
  image,
  name,
  sync,
  value
}: {
  image: null | string
  name: string
  sync?: string
  value: AvatarStyle
}) {
  const color = image ? null : resolveStyle(value).color.value

  return (
    <div
      className="flex flex-col items-center gap-3 rounded-2xl bg-surface px-4 pt-6 pb-4 transition-colors duration-[var(--hex-motion-fast)]"
      data-testid="face-stage"
      style={
        color
          ? { backgroundColor: `color-mix(in srgb, ${color} var(--hex-bot-wash), var(--hex-surface))` }
          : undefined
      }
    >
      <Avatar
        className="hex-pop-in size-[132px]"
        image={image}
        key={image ? 'photo' : `${value.shape}-${value.color}`}
        name={name}
        style={value}
        sync={sync}
      />
      <span className="max-w-full truncate text-[length:var(--text-body)] font-semibold">
        {name}
      </span>
      <p
        className="self-stretch rounded-bubble bg-bubble px-3.5 py-2 text-[length:var(--text-secondary)]"
        style={botBubbleStyle(color)}
      >
        This is how my messages look.
      </p>
    </div>
  )
}

/**
 * The page where a bot's face is picked: the result first, then every shape
 * and colour. Each pick is saved at once, with its picture for clients that
 * only show pictures. A photo takes the face's place until a shape or a
 * colour is picked again, or the photo is taken off.
 */
export function FaceTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const [picked, setPicked] = useState<AvatarStyle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bots = useBots(state => state.byName)
  const shown = botFace(bot)
  const read = useFaceRead(shown.image)
  // A picture is a photo until it is read back as a face this app drew, as
  // `Avatar` shows it. A pick shows at once, in place of the photo too.
  const photo = !picked && Boolean(shown.image) && !read
  const value = picked ?? shown.style ?? read ?? bot.kept_face ?? styleForName(bot.display_name)
  const saves = useRef<Promise<unknown>>(Promise.resolve())
  const picks = useRef(0)

  /** One save at a time, in the order they were asked for, so the last one asked for is kept. */
  const save = (work: () => Promise<void> | void) => {
    saves.current = saves.current.then(work).catch(() => undefined)
  }

  const choose = (next: AvatarStyle) => {
    const pick = ++picks.current
    setError(null)
    setPicked(next)
    save(async () => {
      const png = await avatarPng(next)

      // A later pick replaces this one before it is sent.
      if (png && pick === picks.current) {
        await onSave({ avatar: png, face: next })
      }
    })
  }

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      return setError('Choose a PNG, JPEG, or WebP image.')
    }

    if (file.size > MAX_PHOTO_BYTES) {
      return setError('The photo must be 2 MB or smaller.')
    }

    const reader = new FileReader()

    reader.onload = () => {
      setError(null)
      setPicked(null)
      save(() => onSave({ avatar: String(reader.result) }))
    }

    reader.onerror = () => setError('Could not read that image.')
    reader.readAsDataURL(file)
  }

  return (
    <div>
      <Heading
        description={`${bot.display_name}'s shape and colour. Its message bubbles take the colour too.`}
      >
        Face
      </Heading>
      <div className="grid items-start gap-6 @min-[600px]:grid-cols-[200px_minmax(0,1fr)]">
        <div className="grid gap-2.5">
          <FaceStage
            image={photo ? shown.image : null}
            name={bot.display_name}
            sync={shown.sync}
            value={value}
          />
          <div className="grid gap-1">
            {photo ? (
              <>
                <Button onClick={() => fileRef.current?.click()} size="sm">
                  Choose another photo
                </Button>
                <Button
                  onClick={() => {
                    setPicked(null)
                    save(() => onSave({ avatar: null }))
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Back to a face
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={() =>
                    choose(
                      randomStyle([
                        value,
                        ...Object.values(bots).flatMap(other => [other.face, other.kept_face])
                      ])
                    )
                  }
                  size="sm"
                >
                  Shuffle
                </Button>
                <Button onClick={() => fileRef.current?.click()} size="sm" variant="ghost">
                  Use a photo
                </Button>
              </>
            )}
          </div>
          <input
            accept="image/png,image/jpeg,image/webp"
            aria-label="Photo"
            className="hidden"
            onChange={upload}
            ref={fileRef}
            type="file"
          />
        </div>
        <div>
          <FaceChoices onChange={choose} photo={photo} value={value} />
          {photo ? (
            <p className="mt-4 text-[length:var(--text-secondary)] text-muted">
              {bot.display_name} shows a photo. Pick a shape or a colour to go back to a face.
            </p>
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="mt-4 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
