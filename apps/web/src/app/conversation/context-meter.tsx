import { Tooltip } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import type { ContextUsage } from '../../lib/types'

/** Tokens as people read them: 812, 4.1k, 41k, 200k, 1.2M. */
export function formatTokens(tokens: number): string {
  const short = (value: number) => value.toFixed(1).replace(/\.0$/, '')

  if (tokens < 1000) {
    return String(Math.round(tokens))
  }

  if (tokens < 10_000) {
    return `${short(tokens / 1000)}k`
  }

  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}k`
  }

  return `${short(tokens / 1_000_000)}M`
}

/** This close to the compaction point the meter turns warning and asks for a new section. */
const HIGH = 0.85

/** The plain numbers behind the pill, in glossary words: context, section, summarised. */
function describe(amount: string, compactAt: null | number, compacting: boolean, high: boolean) {
  if (compacting) {
    return `${amount} Older messages are being summarised now.`
  }

  if (compactAt == null) {
    return amount
  }

  const point = `${amount} Older messages are summarised at ${formatTokens(compactAt)}.`

  return high
    ? `${point} Start a new section soon. Long sections make the bot slower and less accurate.`
    : point
}

export interface MeterReading {
  /** The pill's text: the percentage, "Compacting" while older messages are summarised, or "Context" while recounting. */
  label: string
  /** The plain numbers, shown on hover and read by assistive tech. */
  detail: string
  /** Everything a screen reader needs in one line. */
  description: string
  compacting: boolean
  /** True after a compaction until the next reply measures the section again. */
  recounting: boolean
  /** Where the compaction point sits on the bar, as a percentage of the window. */
  compactPercent: null | number
  high: boolean
  /** Null while there is no count: compacting from an unknown size, or recounting. */
  percent: null | number
}

/**
 * Turn the daemon's numbers into the meter's words. Null while nothing can be
 * said: no report yet, an unknown window, or no measurement of a fresh
 * section. Right after a compaction there is no count either, but the daemon
 * says it is recounting, and the pill stays with a neutral reading rather
 * than vanishing as if something failed.
 */
export function readContext(context: ContextUsage | null | undefined): MeterReading | null {
  if (!context || context.window == null || context.window <= 0) {
    return null
  }

  const { compact_at: compactAt, compacting, tokens, window } = context
  const recounting = tokens == null && !compacting && context.recounting === true

  if (tokens == null && !compacting && !recounting) {
    return null
  }

  const compactPercent =
    compactAt != null ? Math.min(100, Math.round((compactAt / window) * 100)) : null

  if (tokens == null) {
    const label = compacting ? 'Compacting' : 'Context'

    const detail = compacting
      ? 'Older messages are being summarised now.'
      : 'Recounting after the summary.'

    return {
      compactPercent,
      compacting,
      description: `${compacting ? 'Context, compacting' : 'Context'}. ${detail}`,
      detail,
      high: false,
      label,
      percent: null,
      recounting
    }
  }

  const percent = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))
  const high = !compacting && compactAt != null && tokens >= compactAt * HIGH

  const detail = describe(
    `${formatTokens(tokens)} of ${formatTokens(window)} tokens.`,
    compactAt,
    compacting,
    high
  )

  const label = compacting ? 'Compacting' : `${percent}%`

  return {
    compactPercent,
    compacting,
    description: `Context ${compacting ? `${percent}%, compacting` : label}. ${detail}`,
    detail,
    high,
    label,
    percent,
    recounting: false
  }
}

/**
 * How full the section's context is: a thin bar and a percentage in a glass
 * pill beside the section actions, with the plain numbers on hover and on
 * focus. It draws nothing until the daemon has measured the section, and
 * nothing in rooms, where each bot keeps its own section. The bar never moves
 * on its own; it is redrawn when a turn ends, a compaction starts or ends, or
 * the model changes. The word "Context" goes when the conversation column is
 * narrower than 54rem.
 */
export function ContextMeter({ context }: { context: ContextUsage | null | undefined }) {
  const reading = readContext(context)

  if (!reading) {
    return null
  }

  const { compactPercent, compacting, description, detail, high, label, percent, recounting } =
    reading

  const tone = high ? 'high' : compacting ? 'compacting' : recounting ? 'recounting' : 'low'

  return (
    <Tooltip
      content={<span className="block max-w-[17rem] leading-snug">{detail}</span>}
      trigger={
        <div
          aria-label={description}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={percent == null ? label : undefined}
          className="hex-glass hex-fade hex-focus flex h-9 items-center gap-2 rounded-full px-3 text-[length:var(--text-meta)] tabular-nums"
          data-testid="context-meter"
          data-tone={tone}
          role="meter"
          tabIndex={0}
        />
      }
    >
      <span
        aria-hidden
        className="relative h-[3px] w-7 shrink-0 overflow-hidden rounded-full bg-foreground/10"
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            high ? 'bg-warning' : 'bg-foreground/55'
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
        {compactPercent != null && compactPercent < 100 ? (
          <span
            className="absolute inset-y-0 w-px bg-foreground/35"
            style={{ left: `${compactPercent}%` }}
          />
        ) : null}
      </span>
      <span className={cn('whitespace-nowrap', high ? 'text-warning' : 'text-muted')}>
        {compacting || recounting ? null : <span className="@max-[54rem]:hidden">Context </span>}
        {label}
      </span>
    </Tooltip>
  )
}
