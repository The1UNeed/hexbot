import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  type AvatarStyle,
  avatarSvgDataUrl
} from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'

export interface AvatarBuilderProps {
  onChange: (style: AvatarStyle) => void
  value: AvatarStyle
}

/** Pick a shape and a colour for a bot's face. Live preview on the left. */
export function AvatarBuilder({ onChange, value }: AvatarBuilderProps) {
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
      <div className="flex shrink-0 items-center justify-center sm:w-36">
        <img
          alt="Avatar preview"
          className="hex-face size-28 drop-shadow-sm"
          data-testid="avatar-preview"
          src={avatarSvgDataUrl(value)}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-4">
        <fieldset>
          <legend className="mb-2 text-[length:var(--text-secondary)] text-muted">Shape</legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {AVATAR_SHAPES.map(shape => (
              <button
                aria-label={shape.label}
                aria-pressed={value.shape === shape.id}
                className={cn(
                  'grid aspect-square place-items-center rounded-control border transition-colors duration-[var(--hex-motion-fast)] hover:bg-surface-2',
                  value.shape === shape.id ? 'border-accent bg-surface-2' : 'border-border'
                )}
                key={shape.id}
                onClick={() => onChange({ ...value, shape: shape.id })}
                type="button"
              >
                <img
                  alt=""
                  className="size-7"
                  src={avatarSvgDataUrl({ color: value.color, shape: shape.id })}
                />
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-[length:var(--text-secondary)] text-muted">Colour</legend>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map(color => (
              <button
                aria-label={color.label}
                aria-pressed={value.color === color.id}
                className={cn(
                  'size-8 rounded-full border-2 transition-transform duration-[var(--hex-motion-fast)] hover:scale-110',
                  value.color === color.id ? 'border-foreground' : 'border-transparent'
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
