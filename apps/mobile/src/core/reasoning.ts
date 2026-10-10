import type { ModelOption } from './types'

/** Pi's thinking levels in order; a bot with none set runs at medium. Matches the web app. */
export const REASONING_LEVELS = [
  { label: 'Off', value: 'off' },
  { label: 'Minimal', value: 'minimal' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra high', value: 'xhigh' },
  { label: 'Max', value: 'max' }
] as const

type Level = (typeof REASONING_LEVELS)[number]

/** The levels a model accepts, or all of them when the daemon does not know. */
export function reasoningOptions(model?: ModelOption): readonly Level[] {
  const supported = model?.reasoning_levels
  if (!supported) return REASONING_LEVELS
  // A model that reports no levels does not reason.
  return supported.length
    ? REASONING_LEVELS.filter(level => supported.includes(level.value))
    : REASONING_LEVELS.filter(level => level.value === 'off')
}

/** The level a model actually runs at: Pi rounds up to the next supported level, else down. */
export function runningLevel(level: string, model?: ModelOption): string {
  const supported: string[] = reasoningOptions(model).map(item => item.value)
  if (supported.includes(level)) return level
  const order: string[] = REASONING_LEVELS.map(item => item.value)
  const start = order.indexOf(level)
  return (
    order.slice(start + 1).find(item => supported.includes(item)) ??
    order
      .slice(0, start)
      .reverse()
      .find(item => supported.includes(item)) ??
    supported[0] ??
    level
  )
}

export const levelLabel = (value: string) => REASONING_LEVELS.find(l => l.value === value)?.label
