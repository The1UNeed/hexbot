import { cva, type VariantProps } from 'class-variance-authority'

import { type AvatarStyle, resolveStyle, styleForName } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'

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

/**
 * What the face is doing. The eyes change shape with it: wide while idle,
 * lowered while it waits on you, narrowed while it works, squinted when
 * something went well, closed when it sleeps.
 */
export type FaceMood = 'happy' | 'idle' | 'listening' | 'sleeping' | 'working'

interface Eyes {
  cy: number
  gap: number
  rx: number
  ry: number
}

const EYES: Record<FaceMood, Eyes> = {
  happy: { cy: 46, gap: 19, rx: 4.4, ry: 3 },
  idle: { cy: 48, gap: 18, rx: 3.6, ry: 6.2 },
  listening: { cy: 52, gap: 16, rx: 3.8, ry: 4.6 },
  sleeping: { cy: 50, gap: 18, rx: 4.2, ry: 0.9 },
  working: { cy: 49, gap: 17, rx: 3.2, ry: 4.4 }
}

/** The two eyes for a mood, on a 100x100 face; shared with the brand mark. */
export function FaceEyes({ fill = '#151517', mood = 'idle' }: { fill?: string; mood?: FaceMood }) {
  const eyes = EYES[mood]

  return (
    <g className="hex-gaze">
      <g className="hex-eyes" data-mood={mood}>
        <ellipse
          cx={50 - eyes.gap / 2 - eyes.rx / 2}
          cy={eyes.cy}
          fill={fill}
          rx={eyes.rx}
          ry={eyes.ry}
        />
        <ellipse
          cx={50 + eyes.gap / 2 + eyes.rx / 2}
          cy={eyes.cy}
          fill={fill}
          rx={eyes.rx}
          ry={eyes.ry}
        />
      </g>
    </g>
  )
}

export interface AvatarProps extends VariantProps<typeof avatarVariants> {
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
  const { color, shape } = resolveStyle(style)

  return (
    <svg aria-hidden className={cn('size-full', className)} viewBox="0 0 100 100">
      <path d={shape.path} fill={color.value} />
      <FaceEyes mood={mood} />
    </svg>
  )
}

/**
 * Uploaded image when there is one, otherwise a generated face on a shape
 * and colour derived from the name, so every bot has a face.
 */
export function Avatar({ className, image, mood, name, size, style }: AvatarProps) {
  return (
    <span
      aria-label={name}
      className={cn(avatarVariants({ size }), 'hex-face', className)}
      role="img"
    >
      {image ? (
        <img alt="" className="size-full rounded-full object-cover" src={image} />
      ) : (
        <Face mood={mood} style={style ?? styleForName(name)} />
      )}
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
