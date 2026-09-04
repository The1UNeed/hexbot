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

export interface AvatarProps extends VariantProps<typeof avatarVariants> {
  className?: string
  /** Data URL or `data:<mime>;base64,...` from the bot's profile asset. */
  image?: null | string
  name: string
  /** Face to draw when there is no image; defaults to one derived from the name. */
  style?: AvatarStyle
}

/** A bot face drawn inline so the eyes can blink. */
export function Face({ className, style }: { className?: string; style: AvatarStyle }) {
  const { color, shape } = resolveStyle(style)

  return (
    <svg aria-hidden className={cn('size-full', className)} viewBox="0 0 100 100">
      <path d={shape.path} fill={color.value} />
      <g className="hex-eyes">
        <ellipse cx="41" cy="48" fill="#151517" rx="3.6" ry="6.2" />
        <ellipse cx="59" cy="48" fill="#151517" rx="3.6" ry="6.2" />
      </g>
    </svg>
  )
}

/**
 * Uploaded image when there is one, otherwise a generated face on a shape
 * and colour derived from the name, so every bot has a face.
 */
export function Avatar({ className, image, name, size, style }: AvatarProps) {
  return (
    <span
      aria-label={name}
      className={cn(avatarVariants({ size }), 'hex-face', className)}
      role="img"
    >
      {image ? (
        <img alt="" className="size-full rounded-full object-cover" src={image} />
      ) : (
        <Face style={style ?? styleForName(name)} />
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
