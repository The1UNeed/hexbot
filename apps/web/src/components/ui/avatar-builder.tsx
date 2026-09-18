import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarStyle } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'

import { Avatar, Face } from './avatar'

export interface AvatarBuilderProps {
  className?: string
  onChange: (style: AvatarStyle) => void
  /** Show the large live preview above the pickers. */
  preview?: boolean
  value: AvatarStyle
}

/**
 * Pick a colour and a shape for a bot's face: the face itself, a row of
 * colour dots, and a row of shapes drawn in the chosen colour.
 */
export function AvatarBuilder({ className, onChange, preview = true, value }: AvatarBuilderProps) {
  return (
    <div className={cn('flex flex-col items-center gap-4', className)}>
      {preview ? (
        <div data-testid="avatar-preview">
          <Avatar
            className="hex-pop-in size-24"
            key={`${value.shape}-${value.color}`}
            name="Preview"
            style={value}
          />
        </div>
      ) : null}
      <fieldset>
        <legend className="sr-only">Colour</legend>
        <div className="flex flex-wrap justify-center gap-2.5">
          {AVATAR_COLORS.map(color => (
            <button
              aria-label={color.label}
              aria-pressed={value.color === color.id}
              className={cn(
                'size-5 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] transition-transform duration-[var(--hex-motion-fast)] hover:scale-110',
                value.color === color.id &&
                  'ring-2 ring-foreground ring-offset-2 ring-offset-background'
              )}
              key={color.id}
              onClick={() => onChange({ ...value, color: color.id })}
              style={{ backgroundColor: color.value }}
              type="button"
            />
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="sr-only">Shape</legend>
        <div className="flex flex-wrap justify-center gap-1">
          {AVATAR_SHAPES.map(shape => (
            <button
              aria-label={shape.label}
              aria-pressed={value.shape === shape.id}
              className={cn(
                'grid size-8 place-items-center rounded-control transition-colors duration-[var(--hex-motion-fast)] hover:bg-surface-2',
                value.shape === shape.id && 'bg-surface-2 ring-1 ring-foreground/50'
              )}
              key={shape.id}
              onClick={() => onChange({ ...value, shape: shape.id })}
              type="button"
            >
              <span className="size-6">
                <Face style={{ color: value.color, shape: shape.id }} />
              </span>
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  )
}
