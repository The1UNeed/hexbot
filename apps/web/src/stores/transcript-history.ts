import type { Message, ToolCall } from '../lib/types'

import type { Transcript, TranscriptMessage } from './transcripts'

/** History owns durable rows. Only input and fragment IDs prove overlap. */
export function hydrateHistory(
  existing: Transcript,
  snapshot: Message[]
): Pick<Transcript, 'messages' | 'durableFragments'> {
  const cardEnds = new Set(
    [...existing.approvals, ...existing.clarifies].flatMap(card =>
      card.messageId ? [card.messageId] : []
    )
  )

  const history = snapshot.flatMap(message => {
    const ids = message.fragmentIds ?? []
    const groups: Message[] = []
    let start = 0

    for (let index = 0; index < ids.length - 1; index++) {
      if (cardEnds.has(ids[index]!)) {
        groups.push(...subset(message, new Set(ids.slice(start, index + 1))))
        start = index + 1
      }
    }

    return start ? [...groups, ...subset(message, new Set(ids.slice(start)))] : [message]
  })

  const previous = new Map(existing.messages.map(message => [message.id, message]))

  const local = existing.messages.filter(
    message => message.createdAt && !history.some(row => row.id === message.id)
  )

  const tools = new Map(
    existing.messages.flatMap(message =>
      message.toolCalls.map(tool => [tool.toolId, tool] as const)
    )
  )

  const inputs = local.filter(message => message.role === 'user')
  const adopted = new Set<string>()
  const attachments = new Map<string, Message['attachments']>()

  for (const input of inputs) {
    const rows = history.filter(
      row => row.role === 'user' && input.inputId && row.inputId === input.inputId
    )

    if (rows.length === 1 && inputs.filter(other => other.inputId === input.inputId).length === 1) {
      adopted.add(input.id)
      attachments.set(rows[0]!.id, input.attachments)
    }
  }

  let messages: TranscriptMessage[] = history.map(message => {
    const live = previous.get(message.id)

    const reasoning = local.find(
      candidate => candidate.thinkingId && message.fragmentIds?.includes(candidate.thinkingId)
    )

    const final = local.find(
      candidate => candidate.textId && message.fragmentIds?.includes(candidate.textId)
    )

    return {
      ...message,
      attachments:
        attachments.get(message.id) ?? previous.get(message.id)?.attachments ?? message.attachments,
      thinking: live?.thinking ?? reasoning?.thinking ?? message.thinking,
      thinkingId: live?.thinkingId ?? reasoning?.thinkingId ?? message.thinkingId,
      usage: live?.usage ?? final?.usage ?? message.usage,
      error: live?.error ?? final?.error ?? message.error,
      status: live?.status ?? final?.status ?? message.status,
      toolCalls: message.toolCalls.map(tool =>
        tools.has(tool.toolId) ? mergeTool(tool, tools.get(tool.toolId)!) : tool
      )
    }
  })

  const storedParts = new Map(
    history.flatMap(message =>
      chunks(message)
        .filter(part => part.id)
        .map(part => [part.id!, part.text] as const)
    )
  )

  const storedTools = new Set(
    history.flatMap(message => message.toolCalls.map(tool => tool.toolId))
  )

  for (const live of local) {
    if (adopted.has(live.id)) {
      continue
    }

    if (live.role !== 'assistant') {
      messages.push(live)

      continue
    }

    if (live.error && !existing.turnActive && !(live.textId && storedParts.has(live.textId))) {
      // An unpersisted failure is a local error card, not another answer.
      messages.push({
        ...live,
        role: 'system',
        text: '',
        parts: undefined,
        partIds: undefined,
        textId: undefined,
        fragmentIds: undefined,
        toolCalls: []
      })

      continue
    }

    // A current read after terminal adopts even an unbound legacy answer.
    if (
      !existing.turnActive ||
      (live.turnId && existing.activeTurnId && live.turnId !== existing.activeTurnId)
    ) {
      continue
    }

    const positions = messages.flatMap((message, index) =>
      !message.createdAt && overlaps(live, message) ? [index] : []
    )

    const end = positions.at(-1) ?? messages.length
    let begin = end

    // This is a rendering boundary, not user ownership. Parts on the other
    // side of a durable input/report stay at their actual history positions.
    while (begin > 0) {
      const before = messages[begin - 1]!

      if (
        before.role !== 'assistant' ||
        !before.turnId ||
        before.turnId !== live.turnId ||
        before.createdAt
      ) {
        break
      }

      begin--
    }

    const region = messages.slice(begin, end + 1).filter(message => !message.createdAt)
    const order = region.flatMap(message => message.fragmentIds ?? [])
    const first = order.findIndex(id => live.fragmentIds?.includes(id))
    const last = order.findLastIndex(id => live.fragmentIds?.includes(id))
    const selected = new Set(first < 0 ? [] : order.slice(first, last + 1))

    const closed = region
      .flatMap(message => chunks(message))
      .filter(part => part.id && selected.has(part.id) && part.id !== live.textId)

    closed.push(
      ...chunks(live)
        .slice(0, -1)
        .filter(part => !part.id || !storedParts.has(part.id))
    )

    const selectedTools = region
      .flatMap(message => message.toolCalls)
      .filter(tool => tool.messageId && selected.has(tool.messageId))

    const liveTools = live.toolCalls.filter(
      tool => !storedTools.has(tool.toolId) || (tool.messageId && selected.has(tool.messageId))
    )

    const merged: TranscriptMessage = {
      ...live,
      ...(live.parts || closed.length ? { parts: closed.map(part => part.text) } : {}),
      ...(live.partIds || closed.length ? { partIds: closed.map(part => part.id) } : {}),
      text: live.textId ? (storedParts.get(live.textId) ?? live.text) : live.text,
      toolCalls: [
        ...new Map(
          [...selectedTools, ...liveTools].map(tool => [
            tool.toolId,
            tools.has(tool.toolId) ? mergeTool(tool, tools.get(tool.toolId)!) : tool
          ])
        ).values()
      ]
    }

    if (!selected.size) {
      messages.push(merged)

      continue
    }

    let inserted = false
    messages = messages.flatMap(message => {
      const ids = message.fragmentIds ?? []
      const from = ids.findIndex(id => selected.has(id))

      if (message.createdAt || from < 0) {
        return [message]
      }

      const to = ids.findLastIndex(id => selected.has(id))
      const before = subset(message, new Set(ids.slice(0, from)))
      const after = subset(message, new Set(ids.slice(to + 1)))
      const replacement = inserted ? [] : [merged]
      inserted = true

      return [...before, ...replacement, ...after]
    })
  }

  return { messages, durableFragments: history.flatMap(message => message.fragmentIds ?? []) }
}

function overlaps(a: Message, b: Message) {
  return Boolean(a.fragmentIds?.some(id => b.fragmentIds?.includes(id)))
}

function chunks(message: Message) {
  return [
    ...(message.parts ?? []).map((text, index) => ({ text, id: message.partIds?.[index] })),
    { text: message.text, id: message.textId }
  ]
}

/** Split a folded history bubble by its explicit source fragments. */
function subset(message: Message, ids: Set<string>): Message[] {
  if (!ids.size) {
    return []
  }

  const parts = chunks(message).filter(part => part.id && ids.has(part.id))

  return [
    {
      ...message,
      id: [...ids][0]!,
      fragmentIds: [...ids],
      parts: parts.slice(0, -1).map(part => part.text),
      partIds: parts.slice(0, -1).map(part => part.id),
      text: parts.at(-1)?.text ?? '',
      textId: parts.at(-1)?.id,
      toolCalls: message.toolCalls.filter(tool => tool.messageId && ids.has(tool.messageId))
    }
  ]
}

function mergeTool(stored: ToolCall, live: ToolCall): ToolCall {
  return {
    ...(live.status === 'running' ? { ...live, ...stored } : { ...stored, ...live }),
    messageId: live.messageId ?? stored.messageId,
    args: live.args ?? stored.args
  }
}
