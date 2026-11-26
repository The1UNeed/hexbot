import { ArrowLeftRight, Copy, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { Avatar, useFaceColor } from '../../components/ui/avatar'
import { Dialog } from '../../components/ui/dialog'
import { ScrollArea } from '../../components/ui/scroll-area'
import { SkeletonLines } from '../../components/ui/skeleton'
import { sectionsThread } from '../../lib/api'
import { ASKING_TOOL, asksCompatible, askTarget } from '../../lib/asks'
import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { mediaKind, mediaOf } from '../../lib/media'
import type { ApprovalRequest, Attachment, Bot, ClarifyRequest, Message } from '../../lib/types'
import { useBot } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { sectionsActions, useLiveSessionId } from '../../stores/sections'
import { clarifyWaiting, useTranscript, useTranscripts } from '../../stores/transcripts'
import { type ThreadRef, uiActions, useUi } from '../../stores/ui'

import { AskingRow } from './asking-row'
import { ClarifyCard } from './clarify-card'
import { filesOf, type FileTarget, openFile } from './file-tab'
import { liveMood } from './steps'
import { TagScope } from './tags'

import {
  ApprovalCard,
  Attachments,
  botBubbleStyle,
  BubbleActions,
  bubbleClass,
  CardRow,
  DaySeparator,
  Markdown,
  sentAt,
  separates,
  StoppedCard,
  stoppedCardFor,
  transcriptClass
} from './index'

type Loaded =
  | { bot: string; kind: 'empty'; peer: string; requestedSectionId?: string }
  | { bot: string; kind: 'error'; peer: string; requestedSectionId?: string; text: string }
  | { kind: 'loading' }
  | {
      bot: string
      kind: 'ready'
      liveSessionId: null | string
      messages: Message[]
      peer: string
      requestedSectionId?: string
      sectionId: string
    }

const LOADING: Loaded = { kind: 'loading' }

type ThreadTimelineItem =
  | { at: number; approval: ApprovalRequest; key?: string; kind: 'approval' }
  | { at: number; clarify: ClarifyRequest; kind: 'clarify' }
  | { at: number; kind: 'message'; message: Message }

/** Copy text with a graceful fallback when the Clipboard API is unavailable or rejects. */
export function copyText(text: string): void {
  const fallback = () => {
    if (typeof document === 'undefined' || !document.body) {
      return
    }

    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()

    try {
      document.execCommand?.('copy')
    } finally {
      document.body.removeChild(field)
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(fallback)

    return
  }

  fallback()
}

/** True when the daemon confirmed the thread is gone or forbidden rather than a transient drop. */
function isTerminalThreadError(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code

  return code === 4204 || code === 4205 || code === 4302
}

/** What to tell the user when the daemon refused or lost the thread. */
export function threadErrorText(error: unknown): string {
  const code = (error as { code?: number } | null)?.code
  const message = error instanceof Error ? error.message : String(error)

  if (code === 4302 || /owner/i.test(message)) {
    return 'Only the room owner can open this conversation.'
  }

  if (code === 4204 || code === 4205 || /not found/i.test(message)) {
    return 'This conversation is no longer available.'
  }

  return message || 'The conversation could not be opened.'
}

function combinedText(message: Message): string {
  return [...(message.role === 'assistant' ? (message.parts ?? []) : []), message.text]
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n\n')
}

function chunksOf(message: Message): { id?: string; text: string }[] {
  return [
    ...(message.parts ?? []).map((text, index) => ({ id: message.partIds?.[index], text })),
    { id: message.textId, text: message.text }
  ]
}

function storedExchanges(stored: Message[]): Message[][] {
  const groups: Message[][] = [[]]

  for (const message of stored) {
    if (message.role === 'user') {
      groups.push([])
    } else if (message.role === 'assistant') {
      groups.at(-1)!.push(message)
    }
  }

  return groups
}

function asksConfirmedInCandidates(liveMessage: Message, candidates: Message[]): boolean {
  const liveAsks = liveMessage.toolCalls.filter(call => call.name === ASKING_TOOL)

  if (!liveAsks.length) {
    return true
  }

  const runningStoredAsks = candidates.flatMap(message =>
    message.toolCalls.filter(call => call.name === ASKING_TOOL && call.status === 'running')
  )

  // If history still shows a running ask that a settled live call can resolve,
  // do not drop the live message before `reconcileRunningStoredAsks` settles it.
  if (
    runningStoredAsks.length > 0 &&
    liveAsks.some(
      liveCall =>
        liveCall.status !== 'running' &&
        runningStoredAsks.some(
          storedCall =>
            storedCall.toolId === liveCall.toolId &&
            (storedCall.parentToolCallId ?? '') === (liveCall.parentToolCallId ?? '') &&
            (!liveCall.parentOccurrenceId ||
              !storedCall.parentOccurrenceId ||
              storedCall.parentOccurrenceId === liveCall.parentOccurrenceId) &&
            (!liveCall.messageId ||
              !storedCall.messageId ||
              storedCall.messageId === liveCall.messageId) &&
            asksCompatible(storedCall, liveCall)
        )
    )
  ) {
    return false
  }

  const storedAsks = candidates.flatMap(message =>
    message.toolCalls.filter(call => call.name === ASKING_TOOL && call.status !== 'running')
  )

  const used = new Set<number>()

  return liveAsks.every(liveCall => {
    const matchIndex = storedAsks.findIndex((storedCall, idx) => {
      if (used.has(idx)) {
        return false
      }

      if (
        storedCall.toolId !== liveCall.toolId ||
        (storedCall.parentToolCallId ?? '') !== (liveCall.parentToolCallId ?? '') ||
        (liveCall.parentOccurrenceId &&
          storedCall.parentOccurrenceId &&
          storedCall.parentOccurrenceId !== liveCall.parentOccurrenceId)
      ) {
        return false
      }

      if (liveCall.occurrenceId && storedCall.occurrenceId) {
        return storedCall.occurrenceId === liveCall.occurrenceId
      }

      // When a live call carries its source fragment ID, require the same fragment ID in history
      // so an unbound result from an ambiguous reused tool_call ID never retires another fragment,
      // and still check ask compatibility so parallel calls in one fragment never cross-confirm.
      if (liveCall.messageId && storedCall.messageId !== liveCall.messageId) {
        return false
      }

      return asksCompatible(storedCall, liveCall)
    })

    if (matchIndex < 0) {
      return false
    }

    used.add(matchIndex)

    return true
  })
}

function textMatchesCandidates(liveMessage: Message, candidates: Message[]): boolean {
  const text = combinedText(liveMessage)

  if (!text) {
    return candidates.length > 0
  }

  return candidates.some(message => combinedText(message) === text)
}

/** True when a completed live message is already present in the stored history snapshot. */
export function isConfirmedByStored(
  liveMessage: Message,
  stored: Message[],
  options?: { allowEarlier?: boolean; usedExchanges?: Set<number> }
): boolean {
  if (liveMessage.streaming) {
    return false
  }

  if (liveMessage.error) {
    return stored.some(message => message.error === liveMessage.error)
  }

  if (liveMessage.turnId) {
    const candidates = stored.filter(
      message => message.role === 'assistant' && message.turnId === liveMessage.turnId
    )

    if (!asksConfirmedInCandidates(liveMessage, candidates)) {
      return false
    }

    if (liveMessage.fragmentIds?.length) {
      const storedIds = new Set(stored.flatMap(message => message.fragmentIds ?? []))

      return liveMessage.fragmentIds.every(id => storedIds.has(id))
    }

    return textMatchesCandidates(liveMessage, candidates)
  }

  if (liveMessage.fragmentIds?.length) {
    const candidates = stored.filter(
      message =>
        message.role === 'assistant' &&
        message.fragmentIds?.some(id => liveMessage.fragmentIds!.includes(id))
    )

    if (!asksConfirmedInCandidates(liveMessage, candidates)) {
      return false
    }

    const storedIds = new Set(stored.flatMap(message => message.fragmentIds ?? []))

    return liveMessage.fragmentIds.every(id => storedIds.has(id))
  }

  // Legacy daemon (no turnId or fragmentIds): check the latest stored exchange first.
  // An earlier exchange may retire an older retained reply only when another live message
  // follows it, its timestamp precedes the latest user message, or the latest exchange
  // already has a stored reply with both matching text and its own asks (so a partial Q2
  // reply without asks never lets Q1 drop Q2's completed ask).
  const exchanges = storedExchanges(stored)
  const lastIndex = exchanges.length - 1
  const latest = exchanges[lastIndex] ?? []
  const latestHasText = textMatchesCandidates(liveMessage, latest)

  if (
    !options?.usedExchanges?.has(lastIndex) &&
    asksConfirmedInCandidates(liveMessage, latest) &&
    latestHasText
  ) {
    options?.usedExchanges?.add(lastIndex)

    return true
  }

  const lastUserMessage = stored.findLast(message => message.role === 'user')
  const liveAt = sentAt(liveMessage)
  const lastUserAt = lastUserMessage ? sentAt(lastUserMessage) : 0
  const beforeLatestUser = liveAt > 0 && lastUserAt > 0 && liveAt < lastUserAt

  const explicitAfterLatestUser =
    typeof liveMessage.sentAt === 'number' &&
    typeof lastUserMessage?.sentAt === 'number' &&
    liveMessage.sentAt > 0 &&
    lastUserMessage.sentAt > 0 &&
    liveMessage.sentAt > lastUserMessage.sentAt

  const liveTargets = new Set(
    liveMessage.toolCalls
      .filter(call => call.name === ASKING_TOOL)
      .map(askTarget)
      .filter((target): target is string => Boolean(target))
  )

  const latestTargets = new Set(
    latest
      .flatMap(message => message.toolCalls)
      .filter(call => call.name === ASKING_TOOL && call.status !== 'running')
      .map(askTarget)
      .filter((target): target is string => Boolean(target))
  )

  const latestAsksDisjoint =
    liveTargets.size > 0 &&
    latestTargets.size > 0 &&
    [...liveTargets].every(target => !latestTargets.has(target))

  if (
    exchanges.length > 1 &&
    !explicitAfterLatestUser &&
    (options?.allowEarlier || beforeLatestUser || (latestHasText && latestAsksDisjoint))
  ) {
    for (let index = lastIndex - 1; index >= 0; index--) {
      if (options?.usedExchanges?.has(index)) {
        continue
      }

      const group = exchanges[index]!

      if (asksConfirmedInCandidates(liveMessage, group) && textMatchesCandidates(liveMessage, group)) {
        options?.usedExchanges?.add(index)

        return true
      }
    }
  }

  return false
}

/**
 * Place an unmatched live message (such as a failed reply that has no durable
 * stored projection) after its own turn or at its chronological position so a
 * later stored exchange never pushes an earlier failure to the bottom.
 */
function insertUnmatchedLive(result: Message[], liveMessage: Message): void {
  if (liveMessage.turnId) {
    const turnIndex = result.findLastIndex(message => message.turnId === liveMessage.turnId)

    if (turnIndex >= 0) {
      result.splice(turnIndex + 1, 0, liveMessage)

      return
    }
  }

  if (!liveMessage.streaming) {
    const liveAt = sentAt(liveMessage)

    if (liveAt > 0) {
      const laterIndex = result.findIndex(message => {
        const at = sentAt(message)

        return at > 0 && at > liveAt
      })

      if (laterIndex >= 0) {
        result.splice(laterIndex, 0, liveMessage)

        return
      }
    }
  }

  result.push(liveMessage)
}

function isSameMergedCall(
  storedCall: Message['toolCalls'][number],
  liveCall: Message['toolCalls'][number]
): boolean {
  if (
    liveCall.toolId !== storedCall.toolId ||
    liveCall.name !== storedCall.name ||
    (liveCall.parentToolCallId ?? '') !== (storedCall.parentToolCallId ?? '')
  ) {
    return false
  }

  if (liveCall.occurrenceId && storedCall.occurrenceId) {
    return liveCall.occurrenceId === storedCall.occurrenceId
  }

  if (liveCall.parentToolCallId) {
    if (
      liveCall.parentOccurrenceId &&
      storedCall.parentOccurrenceId &&
      liveCall.parentOccurrenceId !== storedCall.parentOccurrenceId
    ) {
      return false
    }

    if (
      storedCall.name === ASKING_TOOL &&
      liveCall.name === ASKING_TOOL &&
      !asksCompatible(storedCall, liveCall)
    ) {
      return false
    }

    if (liveCall.messageId && storedCall.messageId && liveCall.messageId !== storedCall.messageId) {
      return false
    }

    return true
  }

  if (storedCall.name === ASKING_TOOL && liveCall.name === ASKING_TOOL) {
    if (!asksCompatible(storedCall, liveCall)) {
      return false
    }

    // An untagged completion (omitted messageId when call_0 was reused in one turn)
    // may settle a hydrated running ask with a compatible target and wait mode.
    if (
      storedCall.messageId &&
      !liveCall.messageId &&
      storedCall.status === 'running' &&
      liveCall.status !== 'running'
    ) {
      return true
    }
  }

  if ((liveCall.messageId || storedCall.messageId) && liveCall.messageId !== storedCall.messageId) {
    return false
  }

  return true
}

function mergeToolCalls(
  storedCalls: Message['toolCalls'],
  liveCalls: Message['toolCalls']
): Message['toolCalls'] {
  const usedLive = new Set<number>()
  const merged: Message['toolCalls'] = []

  const matchedParentForStored = new Map<
    Message['toolCalls'][number],
    Message['toolCalls'][number]
  >()

  for (let storedIndex = 0; storedIndex < storedCalls.length; storedIndex++) {
    const storedCall = storedCalls[storedIndex]!

    const storedParent = storedCall.parentToolCallId
      ? owningLiveParent(storedCalls, storedIndex)
      : undefined

    const liveIndex = liveCalls.findIndex((liveCall, idx) => {
      if (usedLive.has(idx) || !isSameMergedCall(storedCall, liveCall)) {
        return false
      }

      if (storedParent && liveCall.parentToolCallId) {
        const liveParent = owningLiveParent(liveCalls, idx)

        if (liveParent) {
          const matchedLiveParent = matchedParentForStored.get(storedParent)

          if (
            (matchedLiveParent && matchedLiveParent !== liveParent) ||
            (liveParent.occurrenceId &&
              storedParent.occurrenceId &&
              liveParent.occurrenceId !== storedParent.occurrenceId) ||
            (liveParent.messageId &&
              storedParent.messageId &&
              liveParent.messageId !== storedParent.messageId)
          ) {
            return false
          }
        }
      }

      return true
    })

    if (liveIndex < 0) {
      merged.push(storedCall)

      continue
    }

    usedLive.add(liveIndex)
    const liveCall = liveCalls[liveIndex]!

    if (!storedCall.parentToolCallId) {
      matchedParentForStored.set(storedCall, liveCall)
    }

    // A settled stored result takes precedence over an older live `running` state
    // (for example after reconnecting past a missed `tool.complete`).
    if (storedCall.status !== 'running' && liveCall.status === 'running') {
      merged.push(storedCall)
    } else {
      merged.push({
        ...liveCall,
        args: liveCall.args ?? storedCall.args,
        messageId: liveCall.messageId ?? storedCall.messageId,
        occurrenceId: liveCall.occurrenceId ?? storedCall.occurrenceId,
        parentOccurrenceId: liveCall.parentOccurrenceId ?? storedCall.parentOccurrenceId,
        summary: liveCall.summary ?? storedCall.summary
      })
    }
  }

  for (let idx = 0; idx < liveCalls.length; idx++) {
    if (!usedLive.has(idx)) {
      merged.push(liveCalls[idx]!)
    }
  }

  return merged
}

function owningLiveParent(
  toolCalls: Message['toolCalls'],
  childIndex: number
): Message['toolCalls'][number] | undefined {
  const child = toolCalls[childIndex]

  if (!child?.parentToolCallId) {
    return undefined
  }

  if (child.parentOccurrenceId) {
    const byOcc = toolCalls.find(
      call =>
        !call.parentToolCallId &&
        call.toolId === child.parentToolCallId &&
        call.occurrenceId === child.parentOccurrenceId
    )

    if (byOcc) {
      return byOcc
    }
  }

  if (child.messageId) {
    const byMsg = toolCalls.find(
      call =>
        !call.parentToolCallId &&
        call.toolId === child.parentToolCallId &&
        call.messageId === child.messageId
    )

    if (byMsg) {
      return byMsg
    }
  }

  let fallback: Message['toolCalls'][number] | undefined

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

/**
 * Reconcile any completed `message_bot` calls on an untagged live fragment (for example
 * when the daemon omits `message_id` on an ambiguous reused `call_0` completion) against
 * a unique matching running stored `message_bot` call in the same turn or latest exchange.
 */
function reconcileRunningStoredAsks(result: Message[], liveMessage: Message): Message {
  const remainingCalls: Message['toolCalls'] = []
  const lastUser = result.findLastIndex(message => message.role === 'user')
  const liveFragments = new Set(liveMessage.fragmentIds ?? [])
  const usedSettled = new Set<string>()
  const claimedSettledAsks = new Map<string, Message['toolCalls'][number]>()
  const claimedStoredParents = new Map<string, Message['toolCalls'][number]>()

  const sameTurnOrExchange = (candidate: Message, msgIndex: number) =>
    candidate.role === 'assistant' &&
    (liveMessage.turnId ? candidate.turnId === liveMessage.turnId : msgIndex > lastUser)

  // Pre-claim stored parents and stored settled asks already accounted for by a settled
  // call in `liveMessage`, so a second `codemode` invocation in the same live bubble can
  // never have its running nested ask suppressed by an earlier settled parent's child.
  for (const liveCall of liveMessage.toolCalls) {
    if (liveCall.status === 'running') {
      continue
    }

    if (!liveCall.parentToolCallId) {
      for (let msgIndex = 0; msgIndex < result.length; msgIndex++) {
        const candidate = result[msgIndex]!

        if (!sameTurnOrExchange(candidate, msgIndex)) {
          continue
        }

        const parentIdx = candidate.toolCalls.findIndex((storedCall, idx) => {
          const parentKey = `${msgIndex}:${idx}`

          return (
            !claimedStoredParents.has(parentKey) &&
            !storedCall.parentToolCallId &&
            storedCall.toolId === liveCall.toolId &&
            storedCall.name === liveCall.name &&
            (!liveCall.occurrenceId ||
              !storedCall.occurrenceId ||
              liveCall.occurrenceId === storedCall.occurrenceId) &&
            (!liveCall.messageId ||
              !storedCall.messageId ||
              liveCall.messageId === storedCall.messageId)
          )
        })

        if (parentIdx >= 0) {
          claimedStoredParents.set(`${msgIndex}:${parentIdx}`, liveCall)

          break
        }
      }
    } else if (liveCall.name === ASKING_TOOL) {
      for (let msgIndex = 0; msgIndex < result.length; msgIndex++) {
        const candidate = result[msgIndex]!

        if (!sameTurnOrExchange(candidate, msgIndex)) {
          continue
        }

        const callIdx = candidate.toolCalls.findIndex(
          (storedCall, idx) =>
            !claimedSettledAsks.has(`${msgIndex}:${idx}`) &&
            storedCall.status !== 'running' &&
            isSameMergedCall(storedCall, liveCall)
        )

        if (callIdx >= 0) {
          claimedSettledAsks.set(`${msgIndex}:${callIdx}`, liveCall)

          break
        }
      }
    }
  }

  for (let liveIndex = 0; liveIndex < liveMessage.toolCalls.length; liveIndex++) {
    const liveCall = liveMessage.toolCalls[liveIndex]!

    if (liveCall.name !== ASKING_TOOL) {
      remainingCalls.push(liveCall)

      continue
    }

    // A nested `codemode` ask omits `messageId` on live events while the persisted child
    // inherits its parent's fragment ID. If the client missed its `tool.complete`, suppress
    // the stale live `running` copy once stored history already holds the settled child —
    // unless the live message carries a distinct parent occurrence/fragment (a newer codemode run).
    if (liveCall.status === 'running') {
      if (liveCall.parentToolCallId) {
        const liveParent = owningLiveParent(liveMessage.toolCalls, liveIndex)

        let settledKey: string | undefined

        for (let msgIndex = 0; msgIndex < result.length && !settledKey; msgIndex++) {
          const candidate = result[msgIndex]!

          if (!sameTurnOrExchange(candidate, msgIndex)) {
            continue
          }

          if (liveParent) {
            const disjointFragments = Boolean(
              liveMessage.fragmentIds?.length &&
                candidate.fragmentIds?.length &&
                !liveMessage.fragmentIds.some(id => candidate.fragmentIds!.includes(id))
            )

            if (disjointFragments) {
              continue
            }
          }

          for (let callIndex = 0; callIndex < candidate.toolCalls.length; callIndex++) {
            const storedCall = candidate.toolCalls[callIndex]!
            const key = `${msgIndex}:${callIndex}`

            if (
              usedSettled.has(key) ||
              claimedSettledAsks.has(key) ||
              storedCall.status === 'running' ||
              storedCall.name !== ASKING_TOOL ||
              storedCall.toolId !== liveCall.toolId ||
              (storedCall.parentToolCallId ?? '') !== liveCall.parentToolCallId ||
              (liveCall.parentOccurrenceId &&
                storedCall.parentOccurrenceId &&
                liveCall.parentOccurrenceId !== storedCall.parentOccurrenceId) ||
              (liveCall.messageId &&
                storedCall.messageId &&
                liveCall.messageId !== storedCall.messageId) ||
              !asksCompatible(storedCall, liveCall)
            ) {
              continue
            }

            if (liveParent) {
              const storedParentIdx = (() => {
                if (storedCall.parentOccurrenceId) {
                  const byOcc = candidate.toolCalls.findIndex(
                    call =>
                      !call.parentToolCallId &&
                      call.toolId === liveParent.toolId &&
                      call.occurrenceId === storedCall.parentOccurrenceId
                  )

                  if (byOcc >= 0) {
                    return byOcc
                  }
                }

                for (let idx = callIndex - 1; idx >= 0; idx--) {
                  const call = candidate.toolCalls[idx]!

                  if (!call.parentToolCallId && call.toolId === liveParent.toolId) {
                    return idx
                  }
                }

                return candidate.toolCalls.findIndex(
                  call => !call.parentToolCallId && call.toolId === liveParent.toolId
                )
              })()

              const storedParent =
                storedParentIdx >= 0 ? candidate.toolCalls[storedParentIdx] : undefined

              const claimedByOther =
                storedParentIdx >= 0 &&
                claimedStoredParents.has(`${msgIndex}:${storedParentIdx}`) &&
                claimedStoredParents.get(`${msgIndex}:${storedParentIdx}`) !== liveParent

              if (
                claimedByOther ||
                (storedParent &&
                  ((liveParent.occurrenceId &&
                    storedParent.occurrenceId &&
                    liveParent.occurrenceId !== storedParent.occurrenceId) ||
                    (liveParent.messageId &&
                      storedParent.messageId &&
                      liveParent.messageId !== storedParent.messageId)))
              ) {
                continue
              }
            }

            settledKey = key

            break
          }
        }

        if (settledKey) {
          usedSettled.add(settledKey)

          continue
        }
      }

      remainingCalls.push(liveCall)

      continue
    }

    const matches: { callIndex: number; msgIndex: number }[] = []
    const settledMatches: { key: string; overlapsLive: boolean }[] = []

    for (let msgIndex = 0; msgIndex < result.length; msgIndex++) {
      const candidate = result[msgIndex]!

      if (candidate.role !== 'assistant') {
        continue
      }

      if (liveMessage.turnId) {
        if (candidate.turnId !== liveMessage.turnId) {
          continue
        }
      } else if (msgIndex <= lastUser) {
        continue
      }

      const overlapsLive = Boolean(candidate.fragmentIds?.some(id => liveFragments.has(id)))

      for (let callIndex = 0; callIndex < candidate.toolCalls.length; callIndex++) {
        const storedCall = candidate.toolCalls[callIndex]!

        if (
          storedCall.name !== ASKING_TOOL ||
          storedCall.toolId !== liveCall.toolId ||
          (storedCall.parentToolCallId ?? '') !== (liveCall.parentToolCallId ?? '') ||
          (liveCall.parentOccurrenceId &&
            storedCall.parentOccurrenceId &&
            storedCall.parentOccurrenceId !== liveCall.parentOccurrenceId)
        ) {
          continue
        }

        if (liveCall.occurrenceId && storedCall.occurrenceId) {
          if (liveCall.occurrenceId !== storedCall.occurrenceId) {
            continue
          }
        } else if (
          liveCall.messageId &&
          storedCall.messageId &&
          liveCall.messageId !== storedCall.messageId
        ) {
          continue
        }

        if (!asksCompatible(storedCall, liveCall)) {
          continue
        }

        if (storedCall.status === 'running') {
          matches.push({ callIndex, msgIndex })
        } else if (
          !liveCall.messageId &&
          !(liveCall.occurrenceId && storedCall.occurrenceId && liveCall.occurrenceId !== storedCall.occurrenceId)
        ) {
          const key = `${msgIndex}:${callIndex}`

          if (
            !usedSettled.has(key) &&
            (!claimedSettledAsks.has(key) || claimedSettledAsks.get(key) === liveCall)
          ) {
            settledMatches.push({ key, overlapsLive })
          }
        }
      }
    }

    const runningTargetedByLive =
      liveFragments.size > 0 &&
      matches.some(({ callIndex, msgIndex }) => {
        const target = result[msgIndex]!
        const storedCall = target.toolCalls[callIndex]!

        return Boolean(
          (storedCall.messageId && liveFragments.has(storedCall.messageId)) ||
            target.fragmentIds?.some(id => liveFragments.has(id))
        )
      })

    // An untagged settled live call that is already accounted for by an unused compatible
    // settled stored call in the same turn must not settle a later running ask reusing `call_0`
    // (unless `liveMessage` specifically names that running ask's fragment and not the settled one).
    const settledAccount = settledMatches.find(
      entry => entry.overlapsLive || !runningTargetedByLive
    )

    if (settledAccount) {
      usedSettled.add(settledAccount.key)

      continue
    }

    if (matches.length === 1) {
      const { callIndex, msgIndex } = matches[0]!
      const targetMsg = result[msgIndex]!
      const storedCall = targetMsg.toolCalls[callIndex]!

      result[msgIndex] = {
        ...targetMsg,
        toolCalls: targetMsg.toolCalls.map((call, idx) =>
          idx === callIndex
            ? {
                ...liveCall,
                args: liveCall.args ?? storedCall.args,
                messageId: liveCall.messageId ?? storedCall.messageId,
                occurrenceId: liveCall.occurrenceId ?? storedCall.occurrenceId,
                parentOccurrenceId: liveCall.parentOccurrenceId ?? storedCall.parentOccurrenceId,
                summary: liveCall.summary ?? storedCall.summary
              }
            : call
        )
      }
    } else {
      remainingCalls.push(liveCall)
    }
  }

  return remainingCalls.length === liveMessage.toolCalls.length
    ? liveMessage
    : { ...liveMessage, toolCalls: remainingCalls }
}

/**
 * Combine stored thread history with live streaming or recently completed
 * fragments without dropping prior completed replies or stored fragments that
 * a late-joining client lacks.
 */
export function mergeThreadMessages(stored: Message[], live: Message[]): Message[] {
  let result = [...stored]
  const usedExchanges = new Set<number>()

  for (let liveIndex = 0; liveIndex < live.length; liveIndex++) {
    const liveMessage = live[liveIndex]!

    if (
      isConfirmedByStored(liveMessage, stored, {
        allowEarlier: liveIndex < live.length - 1,
        usedExchanges
      })
    ) {
      continue
    }

    if (liveMessage.role !== 'assistant') {
      insertUnmatchedLive(result, liveMessage)

      continue
    }

    // Reconcile any completed `message_bot` calls against a unique running stored ask
    // BEFORE branching on `fragmentIds`, so an untagged completion stays settled even when
    // its live message also carries earlier (`a1`) or later (`a3`) fragment IDs.
    const reconciledLive = reconcileRunningStoredAsks(result, liveMessage)

    if (
      !reconciledLive.toolCalls.length &&
      !combinedText(reconciledLive) &&
      !reconciledLive.error &&
      !reconciledLive.thinking &&
      !reconciledLive.clarifies?.length &&
      !reconciledLive.approvals?.length
    ) {
      continue
    }

    if (reconciledLive.fragmentIds?.length) {
      const liveIds = new Set(reconciledLive.fragmentIds)

      const overlapping = result.filter(
        message => message.role === 'assistant' && message.fragmentIds?.some(id => liveIds.has(id))
      )

      if (!overlapping.length) {
        insertUnmatchedLive(result, reconciledLive)

        continue
      }

      const inferredTextId =
        reconciledLive.textId ??
        (reconciledLive.fragmentIds.length === 1 && reconciledLive.text.trim()
          ? reconciledLive.fragmentIds[0]
          : undefined)

      const liveChunks: { id?: string; text: string }[] = [
        ...(reconciledLive.parts ?? []).map((text, idx) => ({
          id: reconciledLive.partIds?.[idx],
          text
        })),
        { id: inferredTextId, text: reconciledLive.text }
      ].filter(chunk => chunk.text.trim())

      const liveChunkById = new Map<string, { index: number; text: string }>()

      for (let idx = 0; idx < liveChunks.length; idx++) {
        const chunk = liveChunks[idx]!

        if (chunk.id) {
          liveChunkById.set(chunk.id, { index: idx, text: chunk.text })
        }
      }

      const placedLive = new Set<number>()
      const orderedChunks: { id?: string; text: string }[] = []

      // Preserve stored fragment order across overlapping chunks so a stale live copy
      // containing only an earlier fragment never reverses or truncates later stored text.
      for (const storedChunk of overlapping.flatMap(chunksOf)) {
        if (!storedChunk.text.trim()) {
          continue
        }

        const matchedLive = storedChunk.id ? liveChunkById.get(storedChunk.id) : undefined

        if (matchedLive) {
          placedLive.add(matchedLive.index)

          const durable = storedChunk.text
          const live = matchedLive.text

          const chosen =
            durable.trim().startsWith(live.trim()) && durable.trim().length > live.trim().length
              ? durable
              : live

          orderedChunks.push({ id: storedChunk.id, text: chosen })
        } else {
          orderedChunks.push(storedChunk)
        }
      }

      for (let idx = 0; idx < liveChunks.length; idx++) {
        if (!placedLive.has(idx)) {
          orderedChunks.push(liveChunks[idx]!)
        }
      }

      const storedClarifies = overlapping.flatMap(message => message.clarifies ?? [])
      const storedApprovals = overlapping.flatMap(message => message.approvals ?? [])

      const mergedTools = mergeToolCalls(
        overlapping.flatMap(message => message.toolCalls),
        reconciledLive.toolCalls
      )

      const allFragmentIds = [
        ...new Set([
          ...overlapping.flatMap(message => message.fragmentIds ?? []),
          ...reconciledLive.fragmentIds
        ])
      ]

      const lastChunk = orderedChunks.at(-1)
      const earlierChunks = orderedChunks.length > 1 ? orderedChunks.slice(0, -1) : []
      const mergedText = lastChunk?.text ?? ''
      const mergedTextId = lastChunk ? lastChunk.id : inferredTextId

      const merged: Message = {
        ...reconciledLive,
        fragmentIds: allFragmentIds,
        text: mergedText,
        ...(mergedTextId !== undefined && { textId: mergedTextId }),
        toolCalls: mergedTools,
        partIds: earlierChunks.length ? earlierChunks.map(chunk => chunk.id) : undefined,
        parts: earlierChunks.length ? earlierChunks.map(chunk => chunk.text) : undefined,
        ...(storedClarifies.length
          ? {
              clarifies: [
                ...storedClarifies,
                ...(reconciledLive.clarifies ?? []).filter(
                  card => !storedClarifies.some(prev => prev.requestId === card.requestId)
                )
              ]
            }
          : {}),
        ...(storedApprovals.length
          ? {
              approvals: [
                ...storedApprovals,
                ...(reconciledLive.approvals ?? []).filter(
                  card => !storedApprovals.some(prev => prev.requestId === card.requestId)
                )
              ]
            }
          : {})
      }

      let inserted = false
      result = result.flatMap(message => {
        if (!overlapping.includes(message)) {
          return [message]
        }

        if (inserted) {
          return []
        }

        inserted = true

        return [merged]
      })

      continue
    }

    // Legacy / unidentified live message: supersede only a trailing stored assistant
    // message after the last question whose text is a prefix of the live reply.
    const liveText = combinedText(reconciledLive)
    const lastUser = result.findLastIndex(message => message.role === 'user')
    let matchIndex = -1

    if (liveText) {
      for (let index = result.length - 1; index > lastUser; index--) {
        const candidate = result[index]!

        if (
          candidate.role !== 'assistant' ||
          candidate.clarifies?.length ||
          candidate.approvals?.length ||
          (candidate.turnId && reconciledLive.turnId && candidate.turnId !== reconciledLive.turnId)
        ) {
          continue
        }

        const candidateText = combinedText(candidate)

        if (candidateText && (liveText === candidateText || liveText.startsWith(candidateText))) {
          matchIndex = index

          break
        }
      }
    }

    if (matchIndex >= 0) {
      const candidate = result[matchIndex]!

      result[matchIndex] = {
        ...reconciledLive,
        toolCalls: mergeToolCalls(candidate.toolCalls, reconciledLive.toolCalls)
      }
    } else {
      insertUnmatchedLive(result, reconciledLive)
    }
  }

  return result
}

function sameApprovalSource(stored: ApprovalRequest, live: ApprovalRequest): boolean {
  return stored.messageId && live.messageId
    ? stored.messageId === live.messageId
    : Boolean(live.turnId) && stored.turnId === live.turnId
}

/** Build the ordered transcript of messages plus anchored stored and live cards. */
function buildThreadTimeline(
  messages: Message[],
  liveClarifies: ClarifyRequest[],
  liveApprovals: ApprovalRequest[]
): ThreadTimelineItem[] {
  const items: ThreadTimelineItem[] = messages.flatMap(message => {
    const at = sentAt(message)

    return [
      { at, kind: 'message' as const, message },
      ...(message.clarifies ?? []).map(clarify => ({ at, clarify, kind: 'clarify' as const })),
      ...(message.approvals ?? []).map(approval => ({
        approval,
        at,
        key: `${message.id}:${approval.requestId}`,
        kind: 'approval' as const
      }))
    ]
  })

  const restoredClarifyIds = new Set(
    messages.flatMap(message => (message.clarifies ?? []).map(card => card.requestId))
  )

  const restoredApprovals = messages.flatMap(message => message.approvals ?? [])

  const isRestoredApproval = (live: ApprovalRequest) => {
    if (!live.decision) {
      return false
    }

    return restoredApprovals.some(stored => {
      if (live.toolId && stored.requestId === live.toolId) {
        return !stored.messageId || !live.messageId || sameApprovalSource(stored, live)
      }

      return stored.requestId === live.requestId
    })
  }

  const cards: ThreadTimelineItem[] = [
    ...liveClarifies
      .filter(card => clarifyWaiting(card) || !restoredClarifyIds.has(card.requestId))
      .map(clarify => ({ at: clarify.receivedAt, clarify, kind: 'clarify' as const })),
    ...liveApprovals
      .filter(card => !isRestoredApproval(card))
      .map(approval => ({ approval, at: approval.receivedAt, kind: 'approval' as const }))
  ]

  for (const card of cards.sort((a, b) => a.at - b.at)) {
    const source =
      card.kind === 'approval'
        ? card.approval.messageId
        : card.kind === 'clarify'
          ? card.clarify.messageId
          : undefined

    const anchor = source
      ? items.findLastIndex(
          item => item.kind === 'message' && item.message.fragmentIds?.includes(source)
        )
      : -1

    let position = anchor < 0 ? items.findIndex(item => item.at > card.at) : anchor + 1

    if (position < 0) {
      position = items.length
    }

    while (
      position < items.length &&
      items[position]!.kind !== 'message' &&
      items[position]!.at <= card.at
    ) {
      position++
    }

    items.splice(position, 0, card)
  }

  return items
}

/** Shared files and generated media produced by a bot reply. */
function sharedAttachments(message: Message): Attachment[] {
  if (message.role !== 'assistant') {
    return []
  }

  const shared = filesOf(message)

  return [
    ...shared.map(file => ({
      id: file.path!,
      kind: mediaKind(file.mime, file.name),
      mime: file.mime,
      name: file.name,
      path: file.path
    })),
    // A file the bot made and then shared shows once.
    ...mediaOf(message.toolCalls)
      .filter(file => !shared.some(entry => entry.path === file.path))
      .map(file => ({ id: file.path, ...file }))
  ]
}

/** True when `message` renders visible speech bubbles or media in the thread transcript. */
function hasVisibleContent(message: Message): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false
  }

  const parts = message.role === 'assistant' ? (message.parts ?? []) : []

  return (
    [...parts, message.text].some(text => text.trim().length > 0) ||
    message.attachments.length > 0 ||
    sharedAttachments(message).length > 0
  )
}

/**
 * One turn of a bot-to-bot dialogue in the main view. Both bots read left to
 * right in one clean column, each with its face tucked beside the foot of its
 * bubbles, its name tinted in its colour above, and a quiet Copy action on
 * hover.
 */
function ThreadMessage({
  askMessage,
  bot,
  joined = false,
  message,
  name,
  onFile,
  onImage,
  sessionId
}: {
  /** Overrides `message` for the turn's ask row; `null` suppresses it on earlier fragments. */
  askMessage?: Message | null
  bot?: Bot
  joined?: boolean
  message: Message
  name: string
  onFile?: (file: FileTarget) => void
  onImage: (source: string) => void
  sessionId?: string
}) {
  const color = useFaceColor(bot, name)

  if (message.role === 'system' || message.role === 'tool') {
    return message.error ? <StoppedCard message={message} name={name} /> : null
  }

  const reply = message.role === 'assistant'

  // Each message of the turn is its own bubble; a reply in progress streams in.
  const bubbles = [...(reply ? (message.parts ?? []) : []), message.text].filter(text =>
    text.trim()
  )

  const shared = sharedAttachments(message)
  const hasArticle = bubbles.length > 0 || message.attachments.length > 0 || shared.length > 0

  if (!hasArticle && !reply) {
    return null
  }

  const askCalls = askMessage === null ? 0 : (askMessage ?? message).toolCalls.length

  if (!hasArticle && !askCalls && !message.error) {
    return null
  }

  const copyAction = [
    {
      icon: <Copy size={14} />,
      label: 'Copy',
      onClick: () => copyText(bubbles.join('\n\n'))
    }
  ]

  // Both sides of a thread are bots: a name in a message opens that bot's thread with the speaker.
  return (
    <TagScope onFile={onFile} speaker={bot?.name ?? null}>
      {hasArticle ? (
        <article
          className={cn('group flex items-end gap-2.5', joined ? 'pt-1' : 'pt-4')}
          data-testid={reply ? 'thread-reply' : 'thread-question'}
        >
          <Avatar
            className="mb-0.5 shrink-0"
            {...botFace(bot)}
            mood={liveMood(message)}
            name={name}
            size="sm"
          />
          <div className="flex min-w-0 max-w-[min(85%,42rem)] flex-col items-start gap-1">
            {joined ? null : (
              <span
                className="px-1 text-[length:var(--text-meta)] font-semibold text-muted"
                style={
                  color
                    ? {
                        color: `color-mix(in srgb, ${color} var(--hex-bot-label-mix), var(--hex-text))`
                      }
                    : undefined
                }
              >
                {name}
              </span>
            )}
            {bubbles.map((text, index) => (
              <div className="group/bubble flex max-w-full gap-1" key={index}>
                <div className={bubbleClass} style={botBubbleStyle(color)}>
                  <div className="hex-prose">
                    <Markdown
                      streaming={message.streaming && index === bubbles.length - 1}
                      text={text}
                    />
                  </div>
                </div>
                {index === bubbles.length - 1 && !message.streaming ? (
                  <BubbleActions actions={copyAction} />
                ) : null}
              </div>
            ))}
            {message.attachments.length ? (
              <Attachments
                attachments={message.attachments}
                mine={false}
                onFile={onFile}
                onImage={onImage}
                sessionId={sessionId}
              />
            ) : null}
            {shared.length ? (
              <Attachments
                attachments={shared}
                mine={false}
                onFile={onFile}
                onImage={onImage}
                sessionId={sessionId}
              />
            ) : null}
          </div>
        </article>
      ) : null}
      {/* The asked bot may ask a third; its row opens that conversation in turn. */}
      {reply && askMessage !== null ? (
        <AskingRow
          fresh={askMessage?.streaming ?? message.streaming}
          message={askMessage ?? message}
          sender={bot?.name ?? null}
        />
      ) : null}
      {reply && message.error ? <StoppedCard message={message} name={name} /> : null}
    </TagScope>
  )
}

/**
 * Full-view bot-to-bot conversation inside the main pane: the private dialogue
 * in which `peer` asks `bot` for help, read-only. Floats a `Bot A ⇄ Bot B`
 * glass pill overhead and a `Close Chat` glass pill at the foot.
 */
export function ThreadView({
  active = true,
  onClose,
  thread
}: {
  /** Only the topmost visible thread listens for Escape. */
  active?: boolean
  /** Override the close action when rendered directly on a peer route. */
  onClose?: () => void
  thread: ThreadRef
}): React.JSX.Element {
  const closeOverlay = useUi(state => state.closeThread)
  const close = onClose ?? closeOverlay
  const receiver = useBot(thread.bot)
  const sender = useBot(thread.peer)
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [lightbox, setLightbox] = useState<null | { sectionId: string; src: string }>(null)
  // Live messages kept on screen after they finish, until the next history read confirms them.
  const [tail, setTail] = useState<string[]>([])
  const bottom = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  const loadedTarget = useRef<{ bot: string; peer: string; sectionId?: string }>({
    bot: thread.bot,
    peer: thread.peer,
    sectionId: thread.sectionId
  })

  // Switching sections for the same bot pair immediately hides the previous section's history and cards.
  const staleForTarget =
    loaded.kind !== 'loading' &&
    (loaded.bot !== thread.bot ||
      loaded.peer !== thread.peer ||
      (loaded.kind === 'ready'
        ? thread.sectionId !== undefined
          ? loaded.sectionId !== thread.sectionId
          : loaded.requestedSectionId !== undefined
        : loaded.requestedSectionId !== thread.sectionId))

  const effectiveLoaded = useMemo<Loaded>(
    () => (staleForTarget ? LOADING : loaded),
    [loaded, staleForTarget]
  )

  const activeLightbox =
    effectiveLoaded.kind === 'ready' && lightbox?.sectionId === effectiveLoaded.sectionId
      ? lightbox.src
      : null

  const openLightbox = (src: string) => {
    if (effectiveLoaded.kind === 'ready') {
      setLightbox({ sectionId: effectiveLoaded.sectionId, src })
    }
  }

  const sectionId =
    thread.sectionId ?? (effectiveLoaded.kind === 'ready' ? effectiveLoaded.sectionId : null)

  // Keep the last resolved live session ID across transient forgetLive reloads so
  // mounted media players (audio/video) and live streams are never interrupted.
  const storeLiveId = useLiveSessionId(sectionId)

  const liveId =
    storeLiveId ?? (effectiveLoaded.kind === 'ready' ? effectiveLoaded.liveSessionId : null)

  const transcript = useTranscript(liveId)
  const streamingId = transcript?.streamingMessageId ?? null
  // Counts finished replies: each one is a reason to read the history again.
  const [completed, setCompleted] = useState(0)
  const wasStreaming = useRef(false)
  // A daemon restart or socket reconnect may drop live sessions or fail an in-flight read;
  // read the thread again once connected.
  const connects = useConnection(state => state.connects)
  const epoch = useConnection(state => state.epoch)
  const changed = useUi(state => state.threadChanged)
  const receiverName = receiver?.display_name ?? thread.bot
  const senderName = sender?.display_name ?? thread.peer

  const openBeside = useMemo(
    () => (liveId ? (file: FileTarget) => openFile(liveId, file, false, sectionId) : undefined),
    [liveId, sectionId]
  )

  useEffect(() => {
    atBottom.current = true
  }, [thread.bot, thread.peer, thread.sectionId])

  useEffect(() => {
    const previous = loadedTarget.current
    const pairChanged = previous.bot !== thread.bot || previous.peer !== thread.peer

    const idChanged =
      previous.sectionId !== thread.sectionId &&
      !(previous.sectionId === undefined && thread.sectionId !== undefined)

    loadedTarget.current = { bot: thread.bot, peer: thread.peer, sectionId: thread.sectionId }

    if (pairChanged || idChanged) {
      wasStreaming.current = false
      setLightbox(null)
      setLoaded({ kind: 'loading' })
      setTail([])
    }

    let stale = false

    const {
      connects: readConnects,
      epoch: readEpoch,
      target: readTarget
    } = useConnection.getState()

    const current = () =>
      !stale &&
      useConnection.getState().target === readTarget &&
      useConnection.getState().epoch === readEpoch &&
      useConnection.getState().connects === readConnects

    const load = async () => {
      try {
        const id =
          thread.sectionId ?? (await sectionsThread(thread.bot, thread.peer)).section?.id ?? null

        if (!current()) {
          return
        }

        if (!id) {
          setLightbox(null)
          setLoaded({
            bot: thread.bot,
            kind: 'empty',
            peer: thread.peer,
            requestedSectionId: thread.sectionId
          })

          return
        }

        // Tell the ui store which section this is, so only its changes read it again.
        uiActions().resolveThread(thread.bot, thread.peer, id)
        const opened = await sectionsActions().openThread(id, thread.peer)

        if (!current()) {
          return
        }

        const liveTranscript = opened.liveSessionId
          ? useTranscripts.getState().bySession[opened.liveSessionId]
          : undefined

        const streaming = liveTranscript?.streamingMessageId ?? null

        setLightbox(previous => (previous?.sectionId === id ? previous : null))
        setLoaded({
          bot: thread.bot,
          kind: 'ready',
          liveSessionId: opened.liveSessionId,
          messages: opened.messages,
          peer: thread.peer,
          requestedSectionId: thread.sectionId,
          sectionId: id
        })
        // Keep the active stream and any completed live message the snapshot has not confirmed yet.
        setTail(previousTail => {
          const liveById = new Map((liveTranscript?.messages ?? []).map(item => [item.id, item]))

          const kept = previousTail.filter(itemId => {
            const item = liveById.get(itemId)

            return item ? item.streaming || !isConfirmedByStored(item, opened.messages) : false
          })

          return streaming && !kept.includes(streaming) ? [...kept, streaming] : kept
        })
      } catch (error) {
        if (current()) {
          const terminal = isTerminalThreadError(error)

          if (terminal) {
            setLightbox(null)
          }

          // Keep an already-loaded conversation on screen across transient background reload
          // errors, but surface definitive deletion (4204/4205) or ownership denial (4302).
          setLoaded(previous =>
            !terminal &&
            previous.kind === 'ready' &&
            previous.bot === thread.bot &&
            previous.peer === thread.peer &&
            (thread.sectionId === undefined
              ? previous.requestedSectionId === undefined
              : previous.sectionId === thread.sectionId)
              ? previous
              : {
                  bot: thread.bot,
                  kind: 'error',
                  peer: thread.peer,
                  requestedSectionId: thread.sectionId,
                  text: threadErrorText(error)
                }
          )
        }
      }
    }

    void load()

    return () => {
      stale = true
    }
  }, [changed, completed, connects, epoch, thread.bot, thread.peer, thread.sectionId])

  // A reply in progress stays on screen once done, until the history read after it confirms it.
  useEffect(() => {
    if (streamingId) {
      // A new reply started: its question is stored by now, so read it in above the reply.
      if (!wasStreaming.current) {
        setCompleted(count => count + 1)
      }

      wasStreaming.current = true
      setTail(ids => (ids.includes(streamingId) ? ids : [...ids, streamingId]))
    } else if (wasStreaming.current) {
      wasStreaming.current = false
      setCompleted(count => count + 1)
    }
  }, [streamingId])

  useEffect(() => {
    if (!active || activeLightbox) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        close()
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [active, activeLightbox, close])

  const live = useMemo(
    () =>
      effectiveLoaded.kind === 'loading'
        ? []
        : (transcript?.messages.filter(
            item => item.streaming || tail.includes(item.id) || Boolean(item.error)
          ) ?? []),
    [effectiveLoaded.kind, tail, transcript?.messages]
  )

  const allMessages = useMemo(
    () =>
      mergeThreadMessages(effectiveLoaded.kind === 'ready' ? effectiveLoaded.messages : [], live),
    [effectiveLoaded, live]
  )

  const timeline = useMemo(
    () =>
      effectiveLoaded.kind === 'loading'
        ? []
        : buildThreadTimeline(
            allMessages,
            transcript?.clarifies ?? [],
            transcript?.approvals ?? []
          ),
    [allMessages, effectiveLoaded.kind, transcript?.approvals, transcript?.clarifies]
  )

  const liveText = live.at(-1)?.text

  useEffect(() => {
    if (atBottom.current) {
      bottom.current?.scrollIntoView?.({ block: 'end' })
    }
  }, [effectiveLoaded, liveText, timeline.length])

  const stoppedHere =
    effectiveLoaded.kind === 'ready'
      ? stoppedCardFor(receiver, sectionId, allMessages, false)
      : null

  let lastVisible: Message | undefined
  let lastUserKey = 'start'
  let assistantSlot = 0
  const assistantSlotByTurn = new Map<string, number>()

  // Group asks across stored and live fragments of the same turn onto its last assistant message
  // so mid-turn reconnects never show both a settled chip and a running chip for the same bot.
  const askMessageByIndex = new Map<number, Message | null>()
  const assistantIndicesByTurn = new Map<string, number[]>()

  timeline.forEach((item, index) => {
    if (item.kind === 'message' && item.message.role === 'assistant' && item.message.turnId) {
      const indices = assistantIndicesByTurn.get(item.message.turnId) ?? []
      indices.push(index)
      assistantIndicesByTurn.set(item.message.turnId, indices)
    }
  })

  for (const indices of assistantIndicesByTurn.values()) {
    if (indices.length < 2) {
      continue
    }

    const deduped: { call: Message['toolCalls'][number]; msgIdx: number }[] = []
    let streaming = false

    for (const idx of indices) {
      const entry = timeline[idx]

      if (entry?.kind !== 'message') {
        continue
      }

      streaming = streaming || entry.message.streaming

      for (const call of entry.message.toolCalls) {
        const existing = deduped.findIndex(
          prev =>
            prev.msgIdx !== idx &&
            (call.occurrenceId && prev.call.occurrenceId
              ? call.occurrenceId === prev.call.occurrenceId
              : Boolean(call.messageId) &&
                prev.call.messageId === call.messageId &&
                isSameMergedCall(prev.call, call))
        )

        if (existing >= 0) {
          const prev = deduped[existing]!.call

          deduped[existing] = {
            call:
              prev.status !== 'running' && call.status === 'running'
                ? {
                    ...prev,
                    parentOccurrenceId: prev.parentOccurrenceId ?? call.parentOccurrenceId
                  }
                : {
                    ...call,
                    args: call.args ?? prev.args,
                    messageId: call.messageId ?? prev.messageId,
                    occurrenceId: call.occurrenceId ?? prev.occurrenceId,
                    parentOccurrenceId: call.parentOccurrenceId ?? prev.parentOccurrenceId,
                    summary: call.summary ?? prev.summary
                  },
            msgIdx: idx
          }
        } else {
          deduped.push({ call, msgIdx: idx })
        }
      }
    }

    const lastIdx = indices.at(-1)!
    const host = timeline[lastIdx]

    for (const idx of indices) {
      askMessageByIndex.set(idx, null)
    }

    if (host?.kind === 'message') {
      askMessageByIndex.set(lastIdx, {
        ...host.message,
        streaming,
        toolCalls: deduped.map(item => item.call)
      })
    }
  }

  return (
    <div
      aria-label={`${senderName} and ${receiverName}`}
      className="relative h-full bg-background focus:outline-none"
      data-testid="thread-view"
      role="region"
      tabIndex={-1}
    >
      {/* The conversation scrolls cleanly under the floating header and Close Chat pill. */}
      <ScrollArea
        bottom={
          <div className="flex justify-center px-4 pt-2 pb-4">
            <button
              className="hex-glass hex-glass-press hex-focus [--hex-press-scale:1.04] inline-flex h-10 items-center justify-center rounded-full px-6 text-[length:var(--text-body)] font-medium text-foreground/90 hover:text-foreground"
              onClick={close}
              type="button"
            >
              Close Chat
            </button>
          </div>
        }
        className="h-full"
        gap={8}
        onScroll={event => {
          const node = event.currentTarget
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        top={
          <header className="hex-drag flex justify-center px-4 pt-2.5 pb-1 max-[700px]:pl-14">
            <div className="hex-glass flex h-9 max-w-[min(100%,32rem)] min-w-0 items-center gap-2 rounded-full pr-3.5 pl-2">
              <h2
                aria-label={`${senderName} and ${receiverName}`}
                className="flex min-w-0 items-center gap-2 text-[length:var(--text-secondary)] font-semibold"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Avatar {...botFace(sender)} name={senderName} size="sm" />
                  <span className="truncate">{senderName}</span>
                </span>
                <ArrowLeftRight aria-hidden className="shrink-0 text-muted" size={13} />
                <span className="flex min-w-0 items-center gap-1.5">
                  <Avatar {...botFace(receiver)} name={receiverName} size="sm" />
                  <span className="truncate">{receiverName}</span>
                </span>
              </h2>
            </div>
          </header>
        }
        viewportClassName="hex-fade"
      >
        {effectiveLoaded.kind === 'loading' ? (
          <div className={cn(transcriptClass, 'pt-6')}>
            <SkeletonLines label="Loading conversation" />
          </div>
        ) : effectiveLoaded.kind === 'error' ? (
          <div className="grid min-h-[50vh] place-content-center justify-items-center gap-3 p-8 text-center">
            <p className="text-[length:var(--text-secondary)] text-muted" role="alert">
              {effectiveLoaded.text}
            </p>
            <button
              className="hex-glass hex-glass-press hex-focus inline-flex h-8 items-center justify-center rounded-full px-3.5 text-[length:var(--text-meta)] font-medium text-foreground/85 hover:text-foreground"
              onClick={() => setCompleted(count => count + 1)}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : effectiveLoaded.kind === 'empty' && !timeline.length && !stoppedHere ? (
          <div className="grid min-h-[50vh] place-content-center p-8 text-center">
            <p className="text-[length:var(--text-secondary)] text-muted">
              {senderName} has not asked {receiverName} anything yet.
            </p>
          </div>
        ) : (
          <div className={transcriptClass}>
            {timeline.map((item, index) => {
              if (item.kind === 'clarify') {
                lastVisible = undefined

                return (
                  <CardRow bot={receiver} key={`clarify:${item.clarify.requestId}`}>
                    <ClarifyCard bot={receiver} clarify={item.clarify} />
                  </CardRow>
                )
              }

              if (item.kind === 'approval') {
                lastVisible = undefined

                return (
                  <CardRow bot={receiver} key={`approval:${item.key ?? item.approval.requestId}`}>
                    <ApprovalCard approval={item.approval} />
                  </CardRow>
                )
              }

              const { message } = item
              let itemKey: string

              if (message.role === 'user') {
                lastUserKey = message.id
                assistantSlot = 0
                itemKey = `user:${message.id}`
              } else if (message.role === 'assistant') {
                if (message.turnId) {
                  const slot = assistantSlotByTurn.get(message.turnId) ?? 0
                  assistantSlotByTurn.set(message.turnId, slot + 1)
                  itemKey = `turn-id:${message.turnId}:assistant:${slot}`
                } else {
                  itemKey = `turn:${lastUserKey}:assistant:${assistantSlot}`
                  assistantSlot += 1
                }
              } else {
                itemKey = `msg:${message.id}`
              }

              const visible = hasVisibleContent(message)
              const currentAt = sentAt(message)
              const previousAt = lastVisible ? sentAt(lastVisible) : undefined
              const showSeparator = visible && separates(previousAt, currentAt)
              const joined = visible && !showSeparator && lastVisible?.role === message.role

              if (visible) {
                lastVisible = message
              }

              return (
                <Fragment key={itemKey}>
                  {showSeparator ? <DaySeparator time={currentAt} /> : null}
                  <ThreadMessage
                    askMessage={askMessageByIndex.get(index)}
                    bot={message.role === 'user' ? sender : receiver}
                    joined={joined}
                    message={message}
                    name={message.role === 'user' ? senderName : receiverName}
                    onFile={openBeside}
                    onImage={openLightbox}
                    sessionId={liveId ?? undefined}
                  />
                </Fragment>
              )
            })}
            {stoppedHere ? <StoppedCard message={stoppedHere} name={receiverName} /> : null}
            <div className="h-2" ref={bottom} />
          </div>
        )}
      </ScrollArea>
      <Dialog
        onOpenChange={open => !open && setLightbox(null)}
        open={Boolean(activeLightbox)}
        toolbar={
          <button
            aria-label="Close image"
            className="hex-glass hex-glass-press hex-focus grid size-9 shrink-0 place-items-center rounded-full text-foreground/70 hover:text-foreground"
            onClick={() => setLightbox(null)}
            type="button"
          >
            <X size={16} />
          </button>
        }
      >
        <div className="grid max-h-[85dvh] place-items-center bg-black p-2">
          {activeLightbox ? (
            <img
              alt="Attachment preview"
              className="max-h-[78dvh] max-w-full object-contain"
              src={activeLightbox}
            />
          ) : null}
        </div>
      </Dialog>
    </div>
  )
}
