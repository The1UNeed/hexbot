import { ASKING_TOOL, asksCompatible } from '../lib/asks'
import { findToolOccurrence } from '../lib/tool-occurrence'
import type { Message, ToolCall } from '../lib/types'

import type { Transcript, TranscriptMessage } from './transcripts'

/** History owns durable rows. Only input and fragment IDs prove overlap. */
export function hydrateHistory(
  existing: Transcript,
  snapshot: Message[],
  reports: Set<string>,
  inputsAtRead?: Set<string>
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

  // Looked up once per tool, so a long chat reopens in linear time.
  const findLive = occurrences(existing.messages.flatMap(message => message.toolCalls))
  const findStored = occurrences(history.flatMap(message => message.toolCalls))
  const findStoredByName = occurrences(history.flatMap(message => message.toolCalls), true)
  const owners = new Map<string, Message[]>()

  for (const row of history) {
    for (const id of reports.has(row.id) ? [] : (row.fragmentIds ?? [])) {
      const group = owners.get(id)

      if (group) {
        group.push(row)
      } else {
        owners.set(id, [row])
      }
    }
  }

  const fragmentOwners = (source: string | undefined) =>
    (source === undefined ? undefined : owners.get(source)) ?? []

  const sameName = (a?: string, b?: string) =>
    !a || !b || a === 'tool' || b === 'tool' || a === b

  const matchingLive = (tool: ToolCall) => {
    const live = findLive(tool)

    const sameOcc = Boolean(
      tool.occurrenceId && live?.occurrenceId && tool.occurrenceId === live.occurrenceId
    )

    return live &&
      sameName(tool.name, live.name) &&
      !(
        tool.name === ASKING_TOOL &&
        live.name === ASKING_TOOL &&
        !sameOcc &&
        !asksCompatible(tool, live)
      ) &&
      (sameOcc || !tool.messageId || live.messageId === tool.messageId) &&
      (!live.messageId || fragmentOwners(live.messageId).length === 1) &&
      findStored(live) === tool
      ? live
      : undefined
  }

  // When a live tool omits `messageId` (because the daemon reused its `call_0` in a later
  // fragment), only a unique same-name proven stored call within the same turn (or trailing
  // exchange when untagged) with compatible ask args and parent occurrence can represent it,
  // without ever pulling an earlier turn's answer onto the current turn or donating metadata.
  const lastDurableUser = history.findLastIndex(message => message.role === 'user')

  const sameNameProvenStored = (
    liveTool: ToolCall,
    liveMessage: TranscriptMessage,
    liveToolIndex: number
  ) => {
    if (liveTool.messageId || !liveTool.name || liveTool.name === 'tool') {
      return undefined
    }

    const liveParent = owningParent(liveMessage.toolCalls, liveToolIndex)

    const priorLiveParents = liveParent
      ? liveMessage.toolCalls.filter(
          (candidate, index) =>
            index < liveToolIndex &&
            candidate !== liveParent &&
            !candidate.parentToolCallId &&
            candidate.toolId === liveParent.toolId
        ).length
      : 0

    const storedInTurn: ToolCall[] = []
    let matchedStoredParentCount = 0

    for (let index = 0; index < history.length; index++) {
      const candidateMsg = history[index]!

      if (candidateMsg.role !== 'assistant') {
        continue
      }

      if (liveMessage.turnId) {
        if (candidateMsg.turnId !== liveMessage.turnId) {
          continue
        }
      } else if (index <= lastDurableUser) {
        continue
      }

      if (liveParent) {
        const storedParents = candidateMsg.toolCalls.filter(
          candidate => !candidate.parentToolCallId && candidate.toolId === liveParent.toolId
        )

        const storedParent =
          (liveParent.occurrenceId
            ? storedParents.find(candidate => candidate.occurrenceId === liveParent.occurrenceId)
            : undefined) ??
          (liveParent.messageId
            ? storedParents.find(candidate => candidate.messageId === liveParent.messageId)
            : undefined) ??
          storedParents[0]

        if (storedParents.length) {
          matchedStoredParentCount += storedParents.length
        }

        if (
          storedParent &&
          ((liveParent.occurrenceId &&
            storedParent.occurrenceId &&
            liveParent.occurrenceId !== storedParent.occurrenceId) ||
            (liveParent.messageId &&
              storedParent.messageId &&
              liveParent.messageId !== storedParent.messageId) ||
            (!liveParent.occurrenceId &&
              !liveParent.messageId &&
              priorLiveParents >= matchedStoredParentCount))
        ) {
          continue
        }
      }

      for (const candidateTool of candidateMsg.toolCalls) {
        if (
          liveTool.parentOccurrenceId &&
          candidateTool.parentOccurrenceId &&
          liveTool.parentOccurrenceId !== candidateTool.parentOccurrenceId
        ) {
          continue
        }

        if (
          liveTool.name === ASKING_TOOL &&
          candidateTool.name === ASKING_TOOL &&
          !asksCompatible(candidateTool, liveTool)
        ) {
          continue
        }

        storedInTurn.push(candidateTool)
      }
    }

    const stored = findToolOccurrence(liveTool, storedInTurn, { matchName: true })

    if (!stored?.messageId || stored.name !== liveTool.name) {
      return undefined
    }

    const liveInTurn = existing.messages.flatMap(message => {
      if (!message.createdAt || message.role !== 'assistant') {
        return []
      }

      if (liveMessage.turnId && message.turnId && message.turnId !== liveMessage.turnId) {
        return []
      }

      return message.toolCalls.filter(
        candidate =>
          !(
            liveTool.name === ASKING_TOOL &&
            candidate.name === ASKING_TOOL &&
            !asksCompatible(stored, candidate)
          )
      )
    })

    return findToolOccurrence(stored, liveInTurn, { matchName: true }) === liveTool
      ? stored
      : undefined
  }

  const emptied = new Set<Message>()

  // A legacy result can lack its call declaration in the snapshot. A live
  // tool's explicit fragment ID can still prove its owner, never its position.
  for (const message of history) {
    const hadTools = message.toolCalls.length > 0
    message.toolCalls = message.toolCalls.filter(tool => {
      const source = tool.messageId ?? matchingLive(tool)?.messageId

      const owners = fragmentOwners(source)

      if (owners.length !== 1 || owners[0] === message) {
        return true
      }

      tool.messageId = source
      owners[0]!.toolCalls = [...owners[0]!.toolCalls, tool]
      const cards = message.clarifies?.filter(card => card.requestId === tool.toolId) ?? []

      if (cards.length) {
        owners[0]!.clarifies = [
          ...(owners[0]!.clarifies ?? []),
          ...cards.map(card => ({ ...card, messageId: source }))
        ]
        message.clarifies = message.clarifies?.filter(card => card.requestId !== tool.toolId)
      }

      const answered = message.approvals?.filter(card => card.requestId === tool.toolId) ?? []

      if (answered.length) {
        owners[0]!.approvals = [
          ...(owners[0]!.approvals ?? []),
          ...answered.map(card => ({ ...card, messageId: source }))
        ]
        message.approvals = message.approvals?.filter(card => card.requestId !== tool.toolId)
      }

      return false
    })

    if (
      hadTools &&
      !message.toolCalls.length &&
      !message.fragmentIds?.length &&
      !message.text &&
      !message.clarifies?.length &&
      !message.approvals?.length
    ) {
      emptied.add(message)
    }
  }

  history.splice(0, history.length, ...history.filter(message => !emptied.has(message)))

  const local = existing.messages.filter(
    message => message.createdAt && !history.some(row => row.id === message.id)
  )

  const inputs = local.filter(message => message.role === 'user')
  const adopted = new Set<string>()
  const attachments = new Map<string, Message['attachments']>()
  const submissions = new Map<string, TranscriptMessage['submission']>()

  for (const input of inputs) {
    const rows = history.filter(
      row => row.role === 'user' && input.inputId && row.inputId === input.inputId
    )

    if (rows.length === 1 && inputs.filter(other => other.inputId === input.inputId).length === 1) {
      adopted.add(input.id)
      attachments.set(rows[0]!.id, input.attachments)
      submissions.set(rows[0]!.id, input.submission)
    }
  }

  // A queued or steered input can be saved without its ID. A saved user row
  // without one, new in this snapshot, that says the same is that input,
  // newest first. A row already shown, such as one from before the upgrade,
  // never covers it, and nor does one with uploads or a failed or unconfirmed
  // send: a rare miss shows twice, a sent message is never hidden.
  const unbound = history.filter(
    row => row.role === 'user' && !row.inputId && !previous.has(row.id)
  )

  for (const input of [...inputs].reverse()) {
    if (
      adopted.has(input.id) ||
      // A repeated short prompt sent during this read may follow the snapshot.
      // Only an exact input ID can cover that occurrence.
      (inputsAtRead !== undefined && !inputsAtRead.has(input.id)) ||
      input.attachments.length ||
      (input.submission && input.submission.status !== 'accepted')
    ) {
      continue
    }

    const index = unbound.findLastIndex(row => row.text === input.text)

    if (index >= 0) {
      unbound.splice(index, 1)
      adopted.add(input.id)
    }
  }

  let messages: TranscriptMessage[] = history.map(message => {
    const live = previous.get(message.id)

    const reasoning = local.find(candidate =>
      message.fragmentIds?.some(
        id => candidate.thinkingByFragment?.[id] !== undefined || candidate.thinkingId === id
      )
    )

    const final = local.find(
      candidate => candidate.textId && message.fragmentIds?.includes(candidate.textId)
    )

    const submission =
      submissions.get(message.id) ??
      (message.inputId && live?.inputId === message.inputId ? live.submission : undefined)

    return {
      ...message,
      // Exact durable row identity preserves the card's proven Retry binding.
      retryRow: live?.retryRow,
      // An exact durable input proves acceptance even if its RPC later failed.
      submission: submission
        ? {
            ...submission,
            uploads: [],
            status: submission.status === 'rejected' ? 'accepted' : submission.status
          }
        : undefined,
      attachments:
        attachments.get(message.id) ?? previous.get(message.id)?.attachments ?? message.attachments,
      ...reasoningFor(message, live ?? reasoning ?? message),
      usage: live?.usage ?? final?.usage ?? message.usage,
      error: live?.error ?? final?.error ?? message.error,
      status: live?.status ?? final?.status ?? message.status,
      toolCalls: message.toolCalls.map(tool => {
        const live = matchingLive(tool)

        return live ? mergeTool(tool, live) : tool
      })
    }
  })

  const storedParts = new Map(
    history.flatMap(message =>
      chunks(message)
        .filter(part => part.id)
        .map(part => [part.id!, part.text] as const)
    )
  )

  for (const live of local.flatMap(message => splitLive(message, history, reports))) {
    if (adopted.has(live.id)) {
      continue
    }

    if (live.role !== 'assistant') {
      messages.push(live)

      continue
    }

    // A newer run can start before the read: an earlier turn's failure stays too.
    const ended =
      !existing.turnActive ||
      Boolean(live.turnId && existing.activeTurnId && live.turnId !== existing.activeTurnId)

    if (live.error && ended && !(live.textId && storedParts.has(live.textId))) {
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
    if (ended) {
      continue
    }

    const liveIds = new Set(live.fragmentIds ?? [])

    for (let toolIndex = 0; toolIndex < live.toolCalls.length; toolIndex++) {
      const tool = live.toolCalls[toolIndex]!
      const provenSameName = sameNameProvenStored(tool, live, toolIndex)
      const stored = findStoredByName(tool) ?? provenSameName

      if (
        stored?.messageId &&
        ((tool.occurrenceId && stored.occurrenceId === tool.occurrenceId) ||
          provenSameName === stored)
      ) {
        liveIds.add(stored.messageId)
      }
    }

    const positions = messages.flatMap((message, index) =>
      !message.createdAt && message.fragmentIds?.some(id => liveIds.has(id)) ? [index] : []
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
    const first = order.findIndex(id => liveIds.has(id))
    const last = order.findLastIndex(id => liveIds.has(id))
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

    const selectedToolSet = new Set(selectedTools)
    const provenMerges = new Map<ToolCall, ToolCall>()

    const liveTools = live.toolCalls.filter((tool, toolIndex) => {
      const provenSameName = sameNameProvenStored(tool, live, toolIndex)

      if (provenSameName?.messageId && selected.has(provenSameName.messageId)) {
        if (
          selectedToolSet.has(provenSameName) &&
          provenSameName.status === 'running' &&
          (tool.status !== 'running' || tool.liveStarted)
        ) {
          provenMerges.set(provenSameName, tool)
        }

        return false
      }

      const stored = findStoredByName(tool)

      if (
        stored &&
        tool.name === ASKING_TOOL &&
        stored.name === ASKING_TOOL &&
        !(tool.occurrenceId && stored.occurrenceId) &&
        !asksCompatible(stored, tool)
      ) {
        return true
      }

      return (
        !stored ||
        (!(
          (tool.occurrenceId && stored.occurrenceId && tool.occurrenceId === stored.occurrenceId) ||
          (tool.messageId && tool.messageId === stored.messageId)
        ) &&
          matchingLive(stored) !== tool)
      )
    })

    // Cards history rebuilt for these fragments stay with them.
    const selectedCards = region
      .flatMap(message => message.approvals ?? [])
      .filter(card => card.messageId && selected.has(card.messageId))

    const merged: TranscriptMessage = {
      ...live,
      ...(live.parts || closed.length ? { parts: closed.map(part => part.text) } : {}),
      ...(live.partIds || closed.length ? { partIds: closed.map(part => part.id) } : {}),
      text: live.textId ? (storedParts.get(live.textId) ?? live.text) : live.text,
      toolCalls: [
        ...selectedTools.map(tool => {
          const liveMatch = provenMerges.get(tool)

          return liveMatch ? mergeTool(tool, liveMatch) : tool
        }),
        ...liveTools
      ],
      ...(selectedCards.length && { approvals: selectedCards })
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

/** `findToolOccurrence` over `tools`, grouped once by call ID and parent scope. */
function occurrences(tools: ToolCall[], matchName = false) {
  const key = (tool: Pick<ToolCall, 'toolId' | 'parentToolCallId'>) =>
    `${tool.toolId}\u0000${tool.parentToolCallId ?? ''}`

  const groups = new Map<string, ToolCall[]>()

  for (const tool of tools) {
    const group = groups.get(key(tool))

    if (group) {
      group.push(tool)
    } else {
      groups.set(key(tool), [tool])
    }
  }

  return (tool: ToolCall) => findToolOccurrence(tool, groups.get(key(tool)) ?? [], { matchName })
}

function chunks(message: Message) {
  return [
    ...(message.parts ?? []).map((text, index) => ({ text, id: message.partIds?.[index] })),
    { text: message.text, id: message.textId }
  ]
}

/** Keep each source fragment on its own side of a durable input or report. */
function splitLive(
  message: TranscriptMessage,
  history: Message[],
  reports: Set<string>
): TranscriptMessage[] {
  if (message.role !== 'assistant' || !message.fragmentIds?.length) {
    return [message]
  }

  let region = 0
  const regions = new Map<string, number>()

  for (const row of history) {
    if (
      row.role !== 'assistant' ||
      reports.has(row.id) ||
      !row.turnId ||
      row.turnId !== message.turnId
    ) {
      region++
    } else {
      for (const id of row.fragmentIds ?? []) {
        regions.set(id, region)
      }
    }
  }

  const group = (id: string | undefined) => (id ? regions.get(id) : undefined) ?? region
  const groups = new Map<number, string[]>()

  for (const id of message.fragmentIds) {
    const at = group(id)
    groups.set(at, [...(groups.get(at) ?? []), id])
  }

  if (groups.size < 2) {
    return [message]
  }

  const current = group(message.textId ?? message.partIds?.at(-1) ?? message.fragmentIds.at(-1))

  return [...groups].map(([at, ids]) => {
    const parts = chunks(message)
      .slice(0, -1)
      .filter(part => group(part.id) === at)

    const ownsText = group(message.textId) === at

    return {
      ...message,
      id: at === current ? message.id : `${message.id}:${ids[0]}`,
      fragmentIds: ids,
      parts: parts.map(part => part.text),
      partIds: parts.map(part => part.id),
      text: ownsText ? message.text : '',
      textId: ownsText ? message.textId : undefined,
      ...reasoningFor({ ...message, fragmentIds: ids }, message, at === current),
      toolCalls: message.toolCalls.filter(tool => group(tool.messageId) === at),
      clarifies: message.clarifies?.filter(card => group(card.messageId) === at),
      approvals: message.approvals?.filter(card => group(card.messageId) === at),
      streaming: at === current && message.streaming,
      usage: at === current ? message.usage : undefined,
      error: at === current ? message.error : undefined,
      status: at === current ? message.status : undefined
    }
  })
}

function reasoningFor(
  target: Message,
  source: Message,
  unbound = true
): Pick<Message, 'thinking' | 'thinkingId' | 'thinkingByFragment'> {
  const entries = (target.fragmentIds ?? []).flatMap(id =>
    source.thinkingByFragment?.[id] !== undefined
      ? [[id, source.thinkingByFragment[id]] as const]
      : []
  )

  const owns = source.thinkingId ? target.fragmentIds?.includes(source.thinkingId) : unbound

  return {
    thinking: entries.length
      ? entries.map(([, text]) => text).join('')
      : owns
        ? source.thinking
        : undefined,
    thinkingId: entries.at(-1)?.[0] ?? (owns ? source.thinkingId : undefined),
    thinkingByFragment: entries.length ? Object.fromEntries(entries) : undefined
  }
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
      ...reasoningFor({ ...message, fragmentIds: [...ids] }, message),
      clarifies: message.clarifies?.filter(card => card.messageId && ids.has(card.messageId)),
      approvals: message.approvals?.filter(card => card.messageId && ids.has(card.messageId)),
      toolCalls: message.toolCalls.filter(tool => tool.messageId && ids.has(tool.messageId))
    }
  ]
}

function owningParent(toolCalls: readonly ToolCall[], childIndex: number): ToolCall | undefined {
  const child = toolCalls[childIndex]

  if (!child?.parentToolCallId) {
    return undefined
  }

  if (child.parentOccurrenceId) {
    const byOcc = toolCalls.find(
      candidate =>
        !candidate.parentToolCallId &&
        candidate.toolId === child.parentToolCallId &&
        candidate.occurrenceId === child.parentOccurrenceId
    )

    if (byOcc) {
      return byOcc
    }
  }

  if (child.messageId) {
    const byMessage = toolCalls.find(
      candidate =>
        !candidate.parentToolCallId &&
        candidate.toolId === child.parentToolCallId &&
        candidate.messageId === child.messageId
    )

    if (byMessage) {
      return byMessage
    }
  }

  let fallback: ToolCall | undefined

  for (let index = childIndex - 1; index >= 0; index--) {
    const candidate = toolCalls[index]!

    if (!candidate.parentToolCallId && candidate.toolId === child.parentToolCallId) {
      if (child.status !== 'running' || candidate.status === 'running') {
        return candidate
      }

      fallback ??= candidate
    }
  }

  return fallback
}

function mergeTool(stored: ToolCall, live: ToolCall): ToolCall {
  if (
    !findToolOccurrence(stored, [live], { matchName: true }) ||
    (stored.name === ASKING_TOOL && live.name === ASKING_TOOL && !asksCompatible(stored, live))
  ) {
    return stored
  }

  return {
    ...(live.status === 'running' ? { ...live, ...stored } : { ...stored, ...live }),
    messageId: live.messageId ?? stored.messageId,
    occurrenceId: live.occurrenceId ?? stored.occurrenceId,
    parentOccurrenceId: live.parentOccurrenceId ?? stored.parentOccurrenceId,
    ...(live.liveStarted || stored.liveStarted ? { liveStarted: true } : {}),
    startedAt: stored.startedAt || live.startedAt,
    args: live.args ?? stored.args,
    summary: live.summary ?? stored.summary
  }
}
