import type { ReasoningEffort } from './types'

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
