import { cva, type VariantProps } from 'class-variance-authority'
import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react'

import {
  type AvatarStyle,
  botFace,
  faceReadNow,
  readFace,
  resolveStyle,
  styleForName
} from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import {
  type FaceLook,
  type FaceMood,
  facePreset,
  faceShape,
  type MorphBotElement
} from '../../lib/face'

import { ActProps, type HexbotActName, useAct } from './hexbot-act'

export type { FaceLook, FaceMood }

const avatarVariants = cva('relative inline-flex shrink-0 items-center justify-center', {
  defaultVariants: { size: 'md' },
  variants: {
    size: {
      lg: 'size-10',
      md: 'size-8',
      sm: 'size-6',
      xl: 'size-[72px]',
      xs: 'size-4'
    }
  }
})

export interface LiveFaceProps {
  className?: string
  /** The head's colour; any CSS colour, `currentColor` included. */
  color: string
  /** The eyes' colour. */
  eyes: string
  look?: FaceLook | null
  mood?: FaceMood
  /** The eyes follow the pointer over the page. */
  pointer?: boolean
  /** A Hexbot shape id; drawn as the component shape nearest to it. */
  shape?: string
  /** Hold the head while something else moves the body, as an act does. */
  still?: boolean
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

const motionQuery = () => (typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION) : null)

/** Whether the user asks for reduced motion, kept current as the setting changes. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    notify => {
      const query = motionQuery()
      query?.addEventListener('change', notify)

      return () => query?.removeEventListener('change', notify)
    },
    () => motionQuery()?.matches ?? false,
    () => false
  )
}

/**
 * A face brought to life: the `<morph-bot>` component wearing the mood, look
 * and shape it is given. The component runs its own clock and pauses off
 * screen; this hands it the attributes and, for a look or a held head, a
 * preset over every state. The component only softens motion for reduced
 * motion, so here such a face is paused and stepped whenever its appearance
 * changes: it holds still, and still says what the bot does.
 */
export function LiveFace({
  className,
  color,
  eyes,
  look = null,
  mood = 'idle',
  pointer = false,
  shape = 'hexagon',
  still = false
}: LiveFaceProps) {
  const element = useRef<MorphBotElement>(null)
  const tuned = useRef(false)
  const reduced = useReducedMotion()

  useEffect(() => {
    const preset = facePreset(look, still)

    // A preset replays the state, so an untuned face is left alone.
    if (preset || tuned.current) {
      element.current?.configure(preset ?? {})
      tuned.current = Boolean(preset)
    }
  }, [look, still])

  // Two frames, not one: the engine notices a new shape while drawing the
  // first and settles on it in the second.
  useEffect(() => {
    if (!reduced) {
      return
    }

    const face = element.current
    face?.step()
    const next = requestAnimationFrame(() => face?.step())

    return () => cancelAnimationFrame(next)
  }, [color, eyes, look, mood, reduced, shape, still])

  return (
    <morph-bot
      className={cn('block size-full', className)}
      color={color}
      decorative=""
      eye-color={eyes}
      paused={reduced}
      ref={element}
      shape={faceShape(shape)}
      state={mood}
      {...(pointer ? { 'follow-pointer': '' } : {})}
    />
  )
}

/** A bot face drawn inline and brought to life: it blinks, glances, and moves with its mood. */
export function Face({
  className,
  look,
  mood,
  pointer,
  still,
  style
}: {
  className?: string
  look?: FaceLook | null
  mood?: FaceMood
  pointer?: boolean
  still?: boolean
  style: AvatarStyle
}) {
  const { color, eyes, shape } = resolveStyle(style)

  return (
    <LiveFace
      className={className}
      color={color.value}
      eyes={eyes}
      look={look}
      mood={mood}
      pointer={pointer}
      shape={shape.id}
      still={still}
    />
  )
}

export interface AvatarProps extends VariantProps<typeof avatarVariants> {
  /** An act to keep playing, such as typing while the bot works. A click plays a random one. */
  act?: HexbotActName | null
  className?: string
  /** Data URL or `data:<mime>;base64,...` from the bot's profile asset. */
  image?: null | string
  /** Turned toward a neighbour, as the two faces of an ask are. */
  look?: FaceLook | null
  mood?: FaceMood
  name: string
  /** Face to draw when there is no image; defaults to one derived from the name. */
  style?: AvatarStyle
}

/** The face drawn in a bot's picture once read, `null` for a photo, `undefined` while reading. */
export function useFaceRead(image?: null | string): AvatarStyle | null | undefined {
  const [, settle] = useReducer((count: number) => count + 1, 0)
  const read = image ? faceReadNow(image) : null

  useEffect(() => {
    if (!image || read !== undefined) {
      return
    }

    let live = true

    void readFace(image).then(() => {
      if (live) {
        settle()
      }
    })

    return () => {
      live = false
    }
  }, [image, read])

  return read
}

/**
 * The colour of a bot's face: the one picked in an app, else the one read
 * from its picture, else the one its name gives. `null` for a photo, or with
 * neither a bot nor a name.
 */
export function useFaceColor(
  bot: Parameters<typeof botFace>[0],
  name: null | string
): null | string {
  const { image, style } = botFace(bot)
  const read = useFaceRead(image)

  if (style) {
    return resolveStyle(style).color.value
  }

  if (image) {
    return read ? resolveStyle(read).color.value : null
  }

  return name ? resolveStyle(styleForName(name)).color.value : null
}

/**
 * The generated face, live, whether the bot has none saved or saved one this
 * app drew; any other uploaded picture as it is.
 */
export function Avatar({ act, className, image, look, mood, name, size, style }: AvatarProps) {
  const playing = useAct(act)
  const read = useFaceRead(image)
  const face = read ?? style ?? styleForName(name)
  const picture = image && !read ? image : null
  const shownMood = playing.act?.mood ?? mood ?? 'idle'

  return (
    <span
      aria-label={name}
      className={cn(avatarVariants({ size }), 'hex-face', className)}
      data-look={look ?? undefined}
      data-mood={picture ? undefined : shownMood}
      onClick={playing.play}
      role="img"
    >
      <span className={cn('size-full', playing.act?.body)}>
        {picture ? (
          <img alt="" className="size-full rounded-full object-cover" src={picture} />
        ) : (
          <Face look={look} mood={shownMood} still={Boolean(playing.act)} style={face} />
        )}
      </span>
      {playing.name ? (
        <ActProps
          color={picture ? undefined : resolveStyle(face).color.value}
          name={playing.name}
        />
      ) : null}
    </span>
  )
}

/** A person: initials on a neutral disc. */
export function PersonAvatar({
  className,
  name,
  size
}: {
  className?: string
  name: string
  size?: 'md' | 'sm'
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(word => word.charAt(0))
    .join('')
    .toUpperCase()

  return (
    <span
      aria-label={name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-medium text-foreground',
        size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-[length:var(--text-meta)]',
        className
      )}
      role="img"
    >
      {initials || '?'}
    </span>
  )
}
