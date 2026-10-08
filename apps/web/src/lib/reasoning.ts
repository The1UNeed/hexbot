import type { ModelOption, ReasoningEffort } from './types'

/** Pi's thinking levels in order; a bot with none set runs at medium. */
export const REASONING_LEVELS: { label: string; value: ReasoningEffort }[] = [
  { label: 'Off', value: 'off' },
  { label: 'Minimal', value: 'minimal' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra high', value: 'xhigh' },
  { label: 'Max', value: 'max' }
]

/** The levels a model accepts, or all of them when the daemon does not know. */
export function reasoningOptions(model?: ModelOption) {
  const supported = model?.reasoning_levels

  return supported?.length
    ? REASONING_LEVELS.filter(level => supported.includes(level.value))
    : REASONING_LEVELS
}

/** The level a model actually runs at: Pi rounds up to the next supported level, else down. */
export function runningLevel(level: ReasoningEffort, model?: ModelOption): ReasoningEffort {
  const supported = reasoningOptions(model).map(item => item.value)

  if (supported.includes(level)) {
    return level
  }

  const order = REASONING_LEVELS.map(item => item.value)
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
