import { type CSSProperties } from 'react'

import { cn } from '../../lib/cn'

import { type FaceMood, LiveFace } from './avatar'
import { ActProps, type HexbotActName, useAct } from './hexbot-act'

/**
 * The Hexbot mark: a hexagon face in the text colour, eyes cut from the
 * background. It lives like every bot face, and a click makes it play a
 * random act.
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
  const shownMood = playing.act?.mood ?? mood

  return (
    <span
      aria-hidden
      className={cn('hex-face relative inline-block shrink-0 text-foreground', className)}
      data-mood={shownMood}
      onClick={playing.play}
      style={{ height: size, width: size, ...style }}
    >
      <LiveFace
        className={playing.act?.body}
        color="currentColor"
        eyes="var(--hex-background)"
        mood={shownMood}
        shape="hexagon"
        still={Boolean(playing.act)}
      />
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
