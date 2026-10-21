import type { ToolCall } from './types'

type Occurrence = Pick<ToolCall, 'toolId' | 'parentToolCallId' | 'messageId'>

/** Parent scope is explicit. Missing fragment provenance only matches a unique occurrence. */
export function findToolOccurrence<T extends Occurrence>(
  tool: Occurrence,
  candidates: T[]
): T | undefined {
  const scoped = candidates.filter(
    candidate =>
      candidate.toolId === tool.toolId && candidate.parentToolCallId === tool.parentToolCallId
  )

  const exact = tool.messageId
    ? scoped.filter(candidate => candidate.messageId === tool.messageId)
    : []

  if (exact.length) {
    return exact.length === 1 ? exact[0] : undefined
  }

  return scoped.length === 1 && (!tool.messageId || !scoped[0]!.messageId) ? scoped[0] : undefined
}
