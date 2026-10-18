import type { Message } from '../lib/types'

import type { Transcript, TranscriptMessage } from './transcripts'

/**
 * History owns durable rows. Keep only the local tail, matching optimistic
 * users by their position after the last known row, never by equal text.
 * A running turn can already have persisted interim replies and tools. Its
 * closed parts overlap in order; tool IDs identify calls across both views.
 * The terminal reread replaces that turn with its durable rows.
 */
export function hydrateHistory(
  existing: Transcript,
  history: Message[],
  reports: Set<string>
): Pick<Transcript, 'messages' | 'historyBase' | 'historyUsers'> {
  const base = existing.historyBase ?? existing.messages.filter(m => !m.createdAt).map(m => m.id)
  const known = new Set(base)
  const previous = new Map(existing.messages.map(m => [m.id, m]))

  const messages = history.map(message => {
    const live = previous.get(message.id)

    return live
      ? {
          ...message,
          attachments: live.attachments.length ? live.attachments : message.attachments,
          toolCalls: mergeTools(message, live)
        }
      : message
  })

  const local = existing.messages.filter(m => m.createdAt)
  let cursor = messages.findLastIndex(m => known.has(m.id)) + 1
  const running = Boolean(existing.turnActive)
  let retained = false
  let anchor: string | undefined
  const historyUsers: Record<string, string> = {}

  for (let at = 0; at < local.length;) {
    const first = local[at]!

    if (first.role === 'user') {
      const found = messages.findIndex((m, index) => index >= cursor && m.role === 'user')

      if (found >= 0) {
        const stored = messages[found]!
        messages[found] = { ...stored, attachments: first.attachments }
        cursor = found + 1
        anchor = stored.id
      } else {
        messages.push(first)
        cursor = messages.length
        retained = true
        anchor = undefined
      }

      at++

      continue
    }

    let end = at + 1

    while (end < local.length && local[end]?.role !== 'user') {
      end++
    }

    const tail = local.slice(at, end)

    const previousUser = existing.messages
      .slice(
        0,
        existing.messages.findIndex(m => m.id === first.id)
      )
      .findLast(m => m.role === 'user')

    anchor ??=
      existing.historyUsers?.[first.id] ??
      (previousUser && !previousUser.createdAt ? previousUser.id : undefined)

    if (anchor) {
      const found = messages.findIndex(m => m.id === anchor)

      if (found >= 0) {
        cursor = found + 1
      }
    }

    const nextUser = messages.findIndex((m, index) => index >= cursor && m.role === 'user')
    const boundary = nextUser < 0 ? messages.length : nextUser

    const candidates = messages
      .slice(cursor, boundary)
      .filter(
        m =>
          m.role === 'assistant' &&
          (!known.has(m.id) || (m.id === base.at(-1) && m.toolCalls.length > 0)) &&
          !reports.has(m.id)
      )

    // A read begun after completion has the durable answer. An older snapshot
    // with no answer must still leave the just-completed local reply visible.
    if (running || !candidates.length) {
      const claimed = new Set<string>()
      const assistantCount = tail.filter(m => m.role === 'assistant').length

      const merged = tail.map(message => {
        if (message.role !== 'assistant') {
          return message
        }

        const tools = new Set(message.toolCalls.map(tool => tool.toolId))

        const stored =
          candidates.find(m => !claimed.has(m.id) && m.toolCalls.some(t => tools.has(t.toolId))) ??
          candidates.find(m => !claimed.has(m.id))

        if (!stored) {
          return message
        }

        const available = candidates.filter(m => !claimed.has(m.id))
        let count = available.length

        if (assistantCount > 1) {
          const needed = Math.max(
            1,
            (message.parts?.length ?? 0) + Number(!message.streaming && Boolean(message.text))
          )

          const matched = available.indexOf(stored)
          let closed = 0
          count = 0

          while (count < available.length && (closed < needed || count <= matched)) {
            const part = available[count++]!
            closed += (part.parts?.length ?? 0) + Number(Boolean(part.text))
          }
        }

        const overlap = available.slice(0, count)

        for (const part of overlap) {
          claimed.add(part.id)
        }

        const closed = overlap.flatMap(m => [...(m.parts ?? []), ...(m.text ? [m.text] : [])])

        return mergeAssistant(
          {
            ...stored,
            parts: closed.slice(0, -1),
            text: closed.at(-1) ?? '',
            toolCalls: overlap.flatMap(m => m.toolCalls)
          },
          message
        )
      })

      // More persisted bubbles than local ones means the client joined mid-turn.
      // Keep those earlier bubbles; only the identified overlap is replaced.
      const remove = new Set(candidates.filter(m => claimed.has(m.id)).map(m => m.id))
      const kept = messages.slice(cursor, boundary).filter(m => !remove.has(m.id))
      messages.splice(cursor, boundary - cursor, ...kept, ...merged)
      cursor += kept.length + merged.length
      retained ||= merged.length > 0

      if (anchor) {
        for (const message of merged) {
          historyUsers[message.id] = anchor
        }
      }
    } else {
      // Match the completed live bubble to the durable turn by tool ID, or
      // its position within that user's replies. Keep live-only presentation
      // details such as reasoning and visual arguments on the durable row.
      const claimed = new Set<string>()

      for (const message of tail.filter(m => m.role === 'assistant')) {
        const tools = new Set(message.toolCalls.map(tool => tool.toolId))

        const stored =
          candidates.find(m => !claimed.has(m.id) && m.toolCalls.some(t => tools.has(t.toolId))) ??
          candidates.findLast(m => !claimed.has(m.id))

        if (!stored) {
          continue
        }

        claimed.add(stored.id)
        const index = messages.findIndex(m => m.id === stored.id)
        messages[index] = {
          ...stored,
          thinking: message.thinking ?? stored.thinking,
          usage: message.usage ?? stored.usage,
          toolCalls: mergeTools(stored, message)
        }
      }

      // Errors and incident cards have no ordinary history row.
      const cards = tail.filter(m => m.role !== 'assistant')
      messages.splice(boundary, 0, ...cards)
      cursor = boundary + cards.length
      retained ||= cards.length > 0
    }

    // Keep the next user as the anchor for the next local turn.
    at = end
  }

  return { messages, historyBase: retained ? base : undefined, historyUsers }
}

function mergeAssistant(stored: Message, live: TranscriptMessage): TranscriptMessage {
  if (!live.streaming) {
    return { ...live, toolCalls: mergeTools(stored, live) }
  }

  const closed = [...(stored.parts ?? []), ...(stored.text ? [stored.text] : [])]

  return {
    ...live,
    parts: [...closed, ...(live.parts ?? []).slice(closed.length)],
    toolCalls: mergeTools(stored, live)
  }
}

function mergeTools(stored: Message, live: Message): Message['toolCalls'] {
  const tools = new Map(stored.toolCalls.map(tool => [tool.toolId, tool]))

  for (const tool of live.toolCalls) {
    const previous = tools.get(tool.toolId)
    tools.set(
      tool.toolId,
      previous && tool.status === 'running'
        ? { ...tool, ...previous, args: tool.args ?? previous.args }
        : tool
    )
  }

  return [...tools.values()]
}
