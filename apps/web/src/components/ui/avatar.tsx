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
import { FACE_VIEWBOX, type FaceLook, facePose } from '../../lib/face'
import { useFaceVisibility } from '../../lib/face-visibility'

import { ActProps, type HexbotActName, useAct } from './hexbot-act'

export type { FaceMood }
export type { FaceLook } from '../../lib/face'

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
  mood = 'idle',
  look
}: {
  ball?: Ball
  fill?: string
  mood?: FaceMood
  look?: FaceLook | null
}) {
  return (
    <g transform={ballTransform(ball)}>
      <g transform={facePose(mood, look)}>
        <g className="hex-gaze">
          <g className="hex-eyes" data-mood={mood}>
            {eyeRects(mood).map((eye, index) => (
              <rect fill={fill} key={index} {...eye} />
            ))}
          </g>
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
  look?: FaceLook | null
  mood?: FaceMood
  name: string
  /** Face to draw when there is no image; defaults to one derived from the name. */
  style?: AvatarStyle
}

export interface LiveFaceProps {
  className?: string
  color: string
  eyes: string
  look?: FaceLook | null
  mood?: FaceMood
  shape?: string
  /** Hold the eyes while an act moves the body. */
  still?: boolean
}

/** Original SVG, with CSS motion only while a visible bot is active. */
export function LiveFace({
  className,
  color,
  eyes,
  look,
  mood = 'idle',
  shape = 'hexagon',
  still = false
}: LiveFaceProps) {
  const outline = AVATAR_SHAPES.find(item => item.id === shape) ?? AVATAR_SHAPES[0]!
  const { ref, visible } = useFaceVisibility<SVGSVGElement>()

  return (
    <svg
      aria-hidden
      className={cn('hex-live-face size-full', className)}
      data-mood={mood}
      data-moving={visible && !still}
      ref={ref}
      viewBox={FACE_VIEWBOX}
    >
      <path d={outline.path} fill={color} />
      <FaceEyes ball={outline.ball} fill={eyes} look={look} mood={mood} />
    </svg>
  )
}

export function Face({
  style,
  ...props
}: Omit<LiveFaceProps, 'color' | 'eyes' | 'shape'> & { style: AvatarStyle }) {
  const { color, eyes, shape } = resolveStyle(style)

  return <LiveFace {...props} color={color.value} eyes={eyes} shape={shape.id} />
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
  const { ref, visible } = useFaceVisibility<HTMLSpanElement>()
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
      data-visible={visible}
      onClick={playing.play}
      ref={ref}
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
