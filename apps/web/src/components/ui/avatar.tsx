import { cva, type VariantProps } from 'class-variance-authority'
import { useEffect, useId, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from 'react'

import {
  AVATAR_SHAPES,
  type AvatarStyle,
  ballTransform,
  botFace,
  type FaceMood,
  faceReadNow,
  HEX_EYE,
  readFace,
  resolveStyle,
  styleForName
} from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { FACE_VIEWBOX, type FaceLook } from '../../lib/face'
import {
  coreTransform,
  dotLift,
  dotTransform,
  FaceMotion,
  MORPH_KINDS,
  type MorphKind,
  pencilTransform,
  restFrame,
  SPARKS,
  tints
} from '../../lib/face-motion'
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
  /** Hold the face at rest while an act moves the body. */
  still?: boolean
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/** Whether the user asks for reduced motion, kept current as the setting changes. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    notify => {
      const query = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION) : null
      query?.addEventListener('change', notify)

      return () => query?.removeEventListener('change', notify)
    },
    () => (typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION).matches : false),
    () => false
  )
}

/** A four-pointed spark, one unit from its centre to each point. */
const SPARK = 'M0 -1Q0.16 -0.16 1 0Q0.16 0.16 0 1Q-0.16 0.16 -1 0Q-0.16 -0.16 0 -1Z'

/**
 * What a face folds into: three dots while it thinks, a pencil while it
 * writes, a whirl round a dot while it loads.
 */
function Morph({
  color,
  eyes,
  kind,
  tint
}: {
  color: string
  eyes: string
  kind: MorphKind
  tint: string
}) {
  switch (kind) {
    case 'dots':
      return [0, 1, 2].map(index => {
        const lift = dotLift(index, 0)

        return (
          <g
            data-part="dot"
            key={index}
            opacity={Math.round((0.45 + 0.55 * lift) * 100) / 100}
            transform={dotTransform(index, lift)}
          >
            <path d={HEX_EYE} fill={color} />
          </g>
        )
      })

    case 'pencil':
      return (
        <g data-part="pencil" transform={pencilTransform(0)}>
          <path d="M-7 -30a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v42h-14Z" fill={color} />
          <path d="M-7 -24h14v5h-14Z" fill={eyes} opacity={0.55} />
          <path d="M-7 12h14l-7 17Z" fill={color} opacity={0.55} />
          <path d="M-2.6 22.4h5.2l-2.6 6.6Z" fill={color} />
        </g>
      )

    case 'whirl':
      return (
        <>
          {[
            { dash: '55 45', rx: 38, ry: 13, turn: -22, width: 6 },
            { dash: '38 62', rx: 31, ry: 10, turn: 30, width: 4.5 }
          ].map(({ dash, rx, ry, turn, width }, index) => (
            <g key={index} transform={`translate(50 52) rotate(${turn})`}>
              <ellipse
                data-part="whirl"
                fill="none"
                pathLength={100}
                rx={rx}
                ry={ry}
                stroke={tint}
                strokeDasharray={dash}
                strokeDashoffset={0}
                strokeLinecap="round"
                strokeWidth={width}
              />
            </g>
          ))}
          <path d={HEX_EYE} fill={color} transform="translate(50 52) scale(7)" />
        </>
      )
  }
}

/**
 * Original SVG brought to life by face-motion.ts: while a visible bot is
 * active its face sways, bobs or hops with its mood, blinks and glances,
 * turns round now and then, and folds into dots, a pencil or a whirl while
 * it thinks, writes or loads. A look turns it toward its neighbour. Held
 * still, off screen, or with reduced motion it rests in its mood's pose.
 */
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
  const reduced = useReducedMotion()
  const motion = useRef<FaceMotion | null>(null)
  const tint = `hex-tint-${useId().replace(/[^\w-]/g, '')}`
  const moving = visible && !still && !reduced
  const rest = restFrame(mood, look)
  const { ball } = outline

  useLayoutEffect(() => {
    // Made once; the effects below hand it every change.
    const face = new FaceMotion(ref.current!, { look, mood })
    motion.current = face

    return () => {
      face.stop()
      motion.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    motion.current?.set({ look, mood })
  }, [look, mood])

  useLayoutEffect(() => {
    const face = motion.current

    if (moving) {
      face?.start()
    } else {
      face?.stop(still || reduced)
    }
  }, [moving, reduced, still])

  return (
    <svg
      aria-hidden
      className={cn('hex-live-face size-full overflow-visible', className)}
      data-look={look ?? undefined}
      data-mood={mood}
      data-moving={moving}
      ref={ref}
      viewBox={FACE_VIEWBOX}
    >
      <defs>
        <linearGradient id={tint} x1={0} x2={1} y1={0} y2={0.3}>
          {tints(color).map((stop, index) => (
            <stop
              key={index}
              offset={index / 2}
              stopColor={stop.color}
              stopOpacity={stop.opacity}
            />
          ))}
        </linearGradient>
      </defs>
      <g data-part="head" transform={rest.head}>
        <g
          className="hex-body"
          data-part="body"
          display={rest.bodyShown ? 'inline' : 'none'}
          transform={rest.body}
        >
          <path d={outline.path} fill={color} />
          <g transform={ballTransform(ball)}>
            <g className="hex-gaze" data-part="gaze" transform={rest.gaze}>
              <g className="hex-eyes" data-mood={mood}>
                {rest.eyes.map((transform, index) => (
                  <g className="hex-eye" data-part="eye" key={index} transform={transform}>
                    <path className="hex-eye-shape" d={HEX_EYE} fill={eyes} />
                  </g>
                ))}
              </g>
            </g>
          </g>
        </g>
        <g data-part="trail" display="none">
          {[
            { dash: '38 62', width: 7 },
            { dash: '26 74', width: 4.5 }
          ].map(({ dash, width }, index) => (
            <ellipse
              cx={50}
              cy={ball.cy}
              data-part="trail-band"
              fill="none"
              key={index}
              pathLength={100}
              rx={ball.r * 1.22 + index * 4}
              ry={ball.r * 0.3 + index * 2}
              stroke={`url(#${tint})`}
              strokeDasharray={dash}
              strokeDashoffset={0}
              strokeLinecap="round"
              strokeWidth={width}
            />
          ))}
        </g>
      </g>
      {MORPH_KINDS.map(kind => (
        <g
          data-morph={kind}
          data-part="morph"
          display={rest.morph === kind ? 'inline' : 'none'}
          key={kind}
          transform={rest.morph === kind ? rest.morphScale : coreTransform(0)}
        >
          <Morph color={color} eyes={eyes} kind={kind} tint={`url(#${tint})`} />
        </g>
      ))}
      <g data-part="sparks" display="none">
        {Array.from({ length: SPARKS }, (_, index) => (
          <g data-part="spark" key={index} transform="scale(0)">
            <path d={SPARK} fill={color} />
          </g>
        ))}
      </g>
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
