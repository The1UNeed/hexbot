import { Avatar as BaseAvatar } from '@base-ui/react/avatar'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn, hueFromString, initialsFromName } from '../../lib/cn'

const avatarVariants = cva('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full', {
  defaultVariants: { size: 'md' },
  variants: {
    size: {
      lg: 'size-16 text-[length:var(--text-title)]',
      md: 'size-8 text-[length:var(--text-secondary)]',
      sm: 'size-6 text-[length:var(--text-meta)]'
    }
  }
})

export interface AvatarProps extends VariantProps<typeof avatarVariants> {
  className?: string
  /** Data URL or `data:<mime>;base64,...` from the bot's profile asset. */
  image?: null | string
  name: string
}

/**
 * Uploaded image when there is one, otherwise initials on a hue derived from
 * the name (docs/ui-design.md).
 */
export function Avatar({ className, image, name, size }: AvatarProps) {
  const hue = hueFromString(name)

  return (
    <BaseAvatar.Root
      aria-label={name}
      className={cn(avatarVariants({ size }), 'font-semibold', className)}
      style={image ? undefined : { backgroundColor: `hsl(${hue} 45% 42%)`, color: 'hsl(0 0% 100%)' }}
    >
      {image ? <BaseAvatar.Image alt={name} className="size-full object-cover" src={image} /> : null}
      <BaseAvatar.Fallback className="select-none">{initialsFromName(name)}</BaseAvatar.Fallback>
    </BaseAvatar.Root>
  )
}
