import type { ToolCall } from './types'

type Occurrence = Pick<
  ToolCall,
  'toolId' | 'parentToolCallId' | 'parentOccurrenceId' | 'messageId' | 'occurrenceId'
> &
  Partial<Pick<ToolCall, 'name'>>

const sameToolName = (a?: string, b?: string) =>
  !a || !b || a === 'tool' || b === 'tool' || a === b

/** Parent scope is explicit. Occurrence IDs prove identity; missing fragment provenance only matches a unique occurrence. */
export function findToolOccurrence<T extends Occurrence>(
  tool: Occurrence,
  candidates: T[],
  options?: { matchName?: boolean }
): T | undefined {
  const scoped = candidates.filter(
    candidate =>
      candidate.toolId === tool.toolId &&
      candidate.parentToolCallId === tool.parentToolCallId &&
      (!tool.parentOccurrenceId ||
        !candidate.parentOccurrenceId ||
        candidate.parentOccurrenceId === tool.parentOccurrenceId) &&
      (!options?.matchName || sameToolName(candidate.name, tool.name))
  )

  if (tool.occurrenceId) {
    const byOcc = scoped.filter(candidate => candidate.occurrenceId === tool.occurrenceId)

    if (byOcc.length) {
      return byOcc.length === 1 ? byOcc[0] : undefined
    }

    if (scoped.length && scoped.every(candidate => Boolean(candidate.occurrenceId))) {
      return undefined
    }
  }

  const byParentOcc = tool.parentOccurrenceId
    ? scoped.filter(candidate => candidate.parentOccurrenceId === tool.parentOccurrenceId)
    : []

  const parentScoped = byParentOcc.length ? byParentOcc : scoped

  const exact = tool.messageId
    ? parentScoped.filter(candidate => candidate.messageId === tool.messageId)
    : []

  if (exact.length) {
    return exact.length === 1 ? exact[0] : undefined
  }

  return parentScoped.length === 1 && (!tool.messageId || !parentScoped[0]!.messageId)
    ? parentScoped[0]
    : undefined
}
