import { cva, type VariantProps } from 'class-variance-authority'
import { useEffect, useReducer } from 'react'

import {
  AVATAR_SHAPES,
  type AvatarStyle,
  type Ball,
  ballTransform,
  botFace,
  eyeRects,
  type FaceMood,
  faceReadNow,
  readFace,
  resolveStyle,
  styleForName
} from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'

import { ActProps, type HexbotActName, useAct } from './hexbot-act'

export type { FaceMood }

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

const HEXAGON_BALL = AVATAR_SHAPES.find(shape => shape.id === 'hexagon')!.ball

/**
 * The two eyes for a mood on a 100x100 face, painted on the shape's ball so
 * the CSS poses in tokens.css turn them with its surface. Shared with the
 * brand mark, which is a hexagon.
 */
export function FaceEyes({
  ball = HEXAGON_BALL,
  fill = '#ffffff',
  mood = 'idle'
}: {
  ball?: Ball
  fill?: string
  mood?: FaceMood
}) {
  return (
    <g transform={ballTransform(ball)}>
      <g className="hex-gaze">
        <g className="hex-eyes" data-mood={mood}>
          {eyeRects(mood).map((eye, index) => (
            <rect fill={fill} key={index} {...eye} />
          ))}
        </g>
      </g>
    </g>
  )
}

export interface AvatarProps extends VariantProps<typeof avatarVariants> {
  /** An act to keep playing, such as typing while the bot works. A click plays a random one. */
  act?: HexbotActName | null
  className?: string
  /** Data URL or `data:<mime>;base64,...` from the bot's profile asset. */
  image?: null | string
  mood?: FaceMood
  name: string
  /** Face to draw when there is no image; defaults to one derived from the name. */
  style?: AvatarStyle
}

/** A bot face drawn inline so the eyes can blink, wander, and change mood. */
export function Face({
  className,
  mood,
  style
}: {
  className?: string
  mood?: FaceMood
  style: AvatarStyle
}) {
  const { color, eyes, shape } = resolveStyle(style)

  return (
    <svg aria-hidden className={cn('size-full', className)} viewBox="0 0 100 100">
      <path d={shape.path} fill={color.value} />
      <FaceEyes ball={shape.ball} fill={eyes} mood={mood} />
    </svg>
  )
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
export function Avatar({ act, className, image, mood, name, size, style }: AvatarProps) {
  const playing = useAct(act)
  const read = useFaceRead(image)
  const face = read ?? style ?? styleForName(name)
  const picture = image && !read ? image : null

  return (
    <span
      aria-label={name}
      className={cn(avatarVariants({ size }), 'hex-face', className)}
      onClick={playing.play}
      role="img"
    >
      <span className={cn('size-full', playing.act?.body)}>
        {picture ? (
          <img alt="" className="size-full rounded-full object-cover" src={picture} />
        ) : (
          <Face mood={playing.act?.mood ?? mood} style={face} />
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
