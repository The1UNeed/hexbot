import type { CSSProperties } from 'react'

import { cn } from '../../lib/cn'

import { FaceEyes, type FaceMood } from './avatar'
import { ActProps, type HexbotActName, useAct } from './hexbot-act'

/**
 * The Hexbot mark: a hexagon face in the text colour, eyes cut from the
 * background. Like every face, a click makes it play a random act.
 */
export function HexbotMark({
  act,
  className,
  mood = 'idle',
  size = 32,
  style
}: {
  /** An act to keep playing. Leave room around the mark: props reach past it. */
  act?: HexbotActName | null
  className?: string
  mood?: FaceMood
  size?: number
  style?: CSSProperties
}) {
  const playing = useAct(act)

  return (
    <span
      aria-hidden
      className={cn('hex-face relative inline-block shrink-0 text-foreground', className)}
      onClick={playing.play}
      style={{ height: size, width: size, ...style }}
    >
      <svg className={cn('size-full', playing.act?.body)} viewBox="0 0 100 100">
        <path
          d="M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z"
          fill="currentColor"
        />
        <FaceEyes fill="var(--hex-background)" mood={playing.act?.mood ?? mood} />
      </svg>
      {playing.name ? <ActProps name={playing.name} /> : null}
    </span>
  )
}

/** Mark plus the product name, for the welcome screen and the connect screen. */
export function Wordmark({
  className,
  mood,
  size = 'md'
}: {
  className?: string
  mood?: FaceMood
  size?: 'lg' | 'md'
}) {
  const large = size === 'lg'

  return (
    <span className={cn('inline-flex items-center', large ? 'gap-4' : 'gap-2.5', className)}>
      <HexbotMark mood={mood} size={large ? 64 : 28} />
      <span
        className={cn(
          'font-medium tracking-[-0.02em] text-foreground',
          large ? 'text-[56px] leading-none' : 'text-[length:var(--text-title)]'
        )}
      >
        Hexbot
      </span>
    </span>
  )
}
