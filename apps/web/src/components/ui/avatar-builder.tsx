import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarStyle } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'

import { Face } from './avatar'

export interface AvatarBuilderProps {
  className?: string
  onChange: (style: AvatarStyle) => void
  /** Show the large live preview beside the pickers. */
  preview?: boolean
  value: AvatarStyle
}

/** Pick a shape and a colour for a bot's face. */
export function AvatarBuilder({ className, onChange, preview = true, value }: AvatarBuilderProps) {
  return (
    <div className={cn('flex flex-col gap-5 sm:flex-row sm:items-center', className)}>
      {preview ? (
        <div className="flex shrink-0 items-center justify-center sm:w-32">
          <div className="hex-face size-24" data-testid="avatar-preview">
            <Face style={value} />
          </div>
        </div>
      ) : null}
      <div className="min-w-0 flex-1 space-y-4">
        <fieldset>
          <legend className="sr-only">Shape</legend>
          <div className="grid grid-cols-4 gap-1.5">
            {AVATAR_SHAPES.map(shape => (
              <button
                aria-label={shape.label}
                aria-pressed={value.shape === shape.id}
                className={cn(
                  'grid aspect-square place-items-center rounded-panel transition-colors duration-[var(--hex-motion-fast)] hover:bg-surface-2',
                  value.shape === shape.id && 'bg-surface-2 ring-1 ring-foreground/40'
                )}
                key={shape.id}
                onClick={() => onChange({ ...value, shape: shape.id })}
                type="button"
              >
                <span className="size-8">
                  <Face style={{ color: value.color, shape: shape.id }} />
                </span>
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="sr-only">Colour</legend>
          <div className="grid grid-cols-6 gap-2">
            {AVATAR_COLORS.map(color => (
              <button
                aria-label={color.label}
                aria-pressed={value.color === color.id}
                className={cn(
                  'mx-auto size-6 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] transition-transform duration-[var(--hex-motion-fast)] hover:scale-110',
                  value.color === color.id &&
                    'ring-2 ring-foreground ring-offset-2 ring-offset-surface'
                )}
                key={color.id}
                onClick={() => onChange({ ...value, color: color.id })}
                style={{ backgroundColor: color.value }}
                type="button"
              />
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  )
}
