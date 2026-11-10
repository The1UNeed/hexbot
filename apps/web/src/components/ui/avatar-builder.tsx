import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  type AvatarStyle,
  resolveStyle
} from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'

import { Face } from './avatar'

export interface FaceChoicesProps {
  className?: string
  onChange: (style: AvatarStyle) => void
  /**
   * The bot shows a photo: nothing is marked as picked and the choices fade,
   * but each still works, as picking one brings the face back.
   */
  photo?: boolean
  value: AvatarStyle
}

/** A heading with the name of what is picked beside it. */
function Choice({
  children,
  picked,
  title
}: {
  children: React.ReactNode
  picked?: string
  title: string
}) {
  return (
    <div aria-label={title} role="group">
      <div className="mb-2 flex items-baseline justify-between text-[length:var(--text-secondary)]">
        <span className="font-semibold">{title}</span>
        <span className="text-muted">{picked}</span>
      </div>
      {children}
    </div>
  )
}

/**
 * Every shape, drawn in the chosen colour, and every colour. The name of each
 * pick shows beside its heading. The choices hold still: the face they make
 * is the one that moves.
 */
export function FaceChoices({ className, onChange, photo = false, value }: FaceChoicesProps) {
  const { color, shape } = resolveStyle(value)

  return (
    <div
      className={cn(
        'grid gap-5 transition-opacity duration-[var(--hex-motion-fast)]',
        photo && 'opacity-50 focus-within:opacity-100 hover:opacity-100',
        className
      )}
    >
      <Choice picked={photo ? undefined : shape.label} title="Shape">
        <div className="grid grid-cols-5 gap-1.5">
          {AVATAR_SHAPES.map(item => {
            const picked = !photo && item.id === shape.id

            return (
              <button
                aria-label={item.label}
                aria-pressed={picked}
                className={cn(
                  'hex-focus grid aspect-square place-items-center rounded-xl transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06]',
                  picked && 'bg-foreground/[0.06] ring-[1.5px] ring-foreground ring-inset'
                )}
                key={item.id}
                onClick={() => onChange({ color: color.id, shape: item.id })}
                title={item.label}
                type="button"
              >
                <span className="size-[62%]">
                  <Face still style={{ color: color.id, shape: item.id }} />
                </span>
              </button>
            )
          })}
        </div>
      </Choice>
      <Choice picked={photo ? undefined : color.label} title="Colour">
        <div className="grid grid-cols-7 justify-items-center gap-x-1.5 gap-y-2.5">
          {AVATAR_COLORS.map(item => {
            const picked = !photo && item.id === color.id

            return (
              <button
                aria-label={item.label}
                aria-pressed={picked}
                className={cn(
                  'hex-focus size-[30px] rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] transition-transform duration-[var(--hex-motion-fast)] hover:scale-110',
                  picked && 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                )}
                key={item.id}
                onClick={() => onChange({ color: item.id, shape: shape.id })}
                style={{ backgroundColor: item.value }}
                title={item.label}
                type="button"
              />
            )
          })}
        </div>
      </Choice>
    </div>
  )
}
