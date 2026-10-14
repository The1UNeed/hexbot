/**
 * Bots, keyed by name and ordered by `last_activity_at` (the daemon already
 * sorts `hexbot.bots.list`). Refreshed on `hexbot.bots.changed`.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { botsCreate, botsDelete, botsGet, botsList, botsUpdate } from '../lib/api'
import type { Bot, BotCreateInput, BotUpdatePatch, Section } from '../lib/types'

import { useRooms } from './rooms'
import { pendingSectionSnapshots, useSections } from './sections'
import { transcriptRevision, useTranscripts } from './transcripts'
import { uiActions } from './ui'

export interface BotsState {
  byName: Record<string, Bot>
  create: (input: BotCreateInput) => Promise<{ bot: Bot; section: Section }>
  error: null | string
  loaded: boolean
  loading: boolean
  order: string[]
  refresh: () => Promise<void>
  refreshOne: (name: string) => Promise<void>
  remove: (name: string) => Promise<void>
  update: (name: string, patch: BotUpdatePatch) => Promise<Bot>
}

function indexBots(bots: Bot[]): Pick<BotsState, 'byName' | 'order'> {
  const byName: Record<string, Bot> = {}

  for (const bot of bots) {
    byName[bot.name] = bot
  }

  return { byName, order: bots.map(bot => bot.name) }
}

function botAnswerScope(name: string, bot?: Bot) {
  const sectionIds = new Set(useSections.getState().idsByBot[name] ?? [])
  const sessionIds = new Set<string>()

  for (const transcript of Object.values(useTranscripts.getState().bySession)) {
    if (transcript.bot === name) {
      sessionIds.add(transcript.sessionId)
    }
  }

  for (const detail of [useBots.getState().byName[name]?.status_detail, bot?.status_detail]) {
    if (detail?.section_id && !detail.room_id) {
      sectionIds.add(detail.section_id)
    }

    if (detail?.session_id) {
      sessionIds.add(detail.session_id)
    }
  }

  // Room transcripts share a section id, but each bot owns its own live session.
  for (const turns of Object.values(useRooms.getState().liveTurnsByRoom)) {
    const live = turns[name]?.live_session_id

    if (live) {
      sessionIds.add(live)
    }
  }

  return { sectionIds: [...sectionIds], sessionIds: [...sessionIds] }
}

let idleRevision = 0
const idleByBot = new Map<string, number>()

const pendingIdleByBot = new Map<
  string,
  { original: Map<string, number>; retired: Map<string, number> }
>()

/** Aggregate Idle also retires activity for sessions not opened yet. */
export function botIdleRevision(name?: string): number {
  return name ? (idleByBot.get(name) ?? 0) : idleRevision
}

function archivedScope(name: string) {
  return {
    ids: Object.values(useSections.getState().byId)
      .filter(section => section.bot === name && section.archived_at)
      .map(section => section.id),
    snapshots: pendingSectionSnapshots(name)
  }
}

function clearBotAnswers(
  name: string,
  bot?: Bot,
  throughRevision?: number,
  archived?: ReturnType<typeof archivedScope>,
  request?: number
): void {
  if (!bot || (bot.status ?? 'idle') === 'idle') {
    idleByBot.set(name, ++idleRevision)
  }

  // Remember ownership before the aggregate moves to a different session or becomes idle.
  const details = [useBots.getState().byName[name]?.status_detail, bot?.status_detail]
  useTranscripts.setState(state => ({
    bySession: Object.fromEntries(
      Object.entries(state.bySession).map(([id, transcript]) => [
        id,
        details.some(detail =>
          detail?.session_id
            ? detail.session_id === id
            : detail?.section_id && !detail.room_id && detail.section_id === transcript.sectionId
        )
          ? { ...transcript, bot: name }
          : transcript
      ])
    )
  }))
  // A non-idle aggregate names one session, not every conversation owned by this bot.
  const detail = bot?.status_detail

  const scope =
    bot && (bot.status ?? 'idle') !== 'idle'
      ? {
          sectionIds:
            !detail?.session_id && !detail?.room_id && detail?.section_id
              ? [detail.section_id]
              : [],
          sessionIds: detail?.session_id ? [detail.session_id] : []
        }
      : botAnswerScope(name, bot)

  if (bot?.status === 'stopped' && detail?.room_id && detail.action?.kind === 'retry') {
    for (const transcript of Object.values(useTranscripts.getState().bySession)) {
      if (transcript.bot === name && transcript.sectionId === `room:${detail.room_id}`) {
        scope.sessionIds.push(transcript.sessionId)
      }
    }
  } else if (bot?.status === 'stopped' && detail?.section_id && detail.action?.kind === 'retry') {
    const sections = useSections.getState()
    const live = sections.liveSessionId[detail.section_id]

    if (live && sections.byId[detail.section_id]?.bot === name) {
      scope.sessionIds.push(live)
    }
  }

  const matchesScope = (id: string, section?: string) =>
    scope.sessionIds.includes(id) || Boolean(section && scope.sectionIds.includes(section))

  const previous = pendingIdleByBot.get(name)

  const inherited = new Map(
    [...(previous?.retired ?? [])].filter(([id, revision]) => {
      const transcript = useTranscripts.getState().bySession[id]

      return (
        transcript?.authorityRevision === revision &&
        (previous!.original.get(id) ?? Infinity) <= (throughRevision ?? Infinity) &&
        matchesScope(id, transcript.sectionId)
      )
    })
  )

  const clear = (
    snapshots: Section[][] = [],
    revisions?: Map<string, number>,
    confirmations = revisions
  ) => {
    // Aggregate Idle excludes archived private conversations without stopping them.
    const excluded = new Set(
      bot && (bot.status ?? 'idle') === 'idle'
        ? [
            ...(archived?.ids ?? []),
            ...snapshots
              .flat()
              .filter(section => section.bot === name && section.archived_at)
              .map(section => section.id)
          ]
        : []
    )

    const archivedSession = (id: string) => {
      const section = useTranscripts.getState().bySession[id]?.sectionId

      return Boolean(section && excluded.has(section))
    }

    const transcripts = useTranscripts.getState()

    if (revisions) {
      for (const [id, revision] of revisions) {
        if (!archivedSession(id) && bot?.status !== 'needs_you') {
          // Disconnect retires activity before the metadata RPC rejects. Card revisions
          // still identify the old confirmations without overwriting newer activity.
          useTranscripts.setState(state => {
            const transcript = state.bySession[id]
            const waiting = transcript?.waitingRequests
            const cutoff = confirmations?.get(id) ?? revision

            if (
              !transcript ||
              transcript.authorityRevision <= revision ||
              !waiting?.some(item => item.revision <= cutoff)
            ) {
              return state
            }

            return {
              bySession: {
                ...state.bySession,
                [id]: {
                  ...transcript,
                  waitingRequests: waiting.filter(item => item.revision > cutoff)
                }
              }
            }
          })
        }

        transcripts.clearAnsweredWaiting(
          [],
          [id],
          revision,
          archivedSession(id)
            ? { preserveWaiting: true, idle: true }
            : {
                preserveWaiting: bot?.status === 'needs_you',
                idle: Boolean(bot && (bot.status ?? 'idle') === 'idle')
              }
        )
      }

      return
    }

    transcripts.clearAnsweredWaiting(
      scope.sectionIds.filter(id => !excluded.has(id)),
      scope.sessionIds.filter(id => !archivedSession(id)),
      throughRevision,
      {
        preserveWaiting: bot?.status === 'needs_you',
        idle: Boolean(bot && (bot.status ?? 'idle') === 'idle')
      }
    )
    transcripts.clearAnsweredWaiting(
      scope.sectionIds.filter(id => excluded.has(id)),
      scope.sessionIds.filter(archivedSession),
      throughRevision,
      { preserveWaiting: true, idle: true }
    )
  }

  if (bot && (bot.status ?? 'idle') === 'idle' && archived?.snapshots.length) {
    const transcripts = useTranscripts.getState()

    const original = new Map(
      Object.values(transcripts.bySession)
        .filter(
          transcript =>
            (transcript.authorityRevision <= (throughRevision ?? Infinity) ||
              inherited.has(transcript.sessionId)) &&
            matchesScope(transcript.sessionId, transcript.sectionId)
        )
        .map(transcript => [
          transcript.sessionId,
          inherited.has(transcript.sessionId)
            ? previous!.original.get(transcript.sessionId)!
            : transcript.authorityRevision
        ])
    )

    // Retire optimism now; only confirmed requests await the concurrent archive metadata.
    for (const id of original.keys()) {
      transcripts.clearAnsweredWaiting([], [id], inherited.get(id) ?? throughRevision, {
        preserveWaiting: true,
        idle: true
      })
    }

    const revisions = new Map(
      [...original.keys()].map(id => [
        id,
        useTranscripts.getState().bySession[id]!.authorityRevision
      ])
    )

    const pending = { original, retired: revisions }
    pendingIdleByBot.set(name, pending)

    void Promise.all(archived.snapshots).then(snapshots => {
      if (
        request !== undefined &&
        (fullBotsRequest > request || (botRequests.get(name) ?? 0) > request) &&
        pendingIdleByBot.get(name) !== pending
      ) {
        return
      }

      if (pendingIdleByBot.get(name) === pending) {
        pendingIdleByBot.delete(name)
      }

      clear(snapshots, revisions, original)
    })
  } else {
    clear()
    clear([], inherited)

    if (previous && pendingIdleByBot.get(name) === previous) {
      // A named snapshot supersedes only its own sessions, not pending sibling cleanup.
      for (const id of previous.retired.keys()) {
        if (matchesScope(id, useTranscripts.getState().bySession[id]?.sectionId)) {
          previous.original.delete(id)
          previous.retired.delete(id)
        }
      }

      if (!bot || (bot.status ?? 'idle') === 'idle' || !previous.retired.size) {
        pendingIdleByBot.delete(name)
      }
    }
  }
}

let botsRequest = 0
let latestBotsRefresh = 0
let fullBotsRequest = 0
const botRequests = new Map<string, number>()
const removedBots = new Map<string, number>()

type SavedBotField = { completed: number; request: number; value: Bot[keyof Bot] }
const savedBotFields = new Map<string, Map<keyof Bot, SavedBotField>>()

function withSavedFields(bot: Bot, request: number): Bot {
  // A concurrent read can capture pre-write metadata but a newer runtime status.
  // Reads started after the edit completed replace the saved fields normally.
  return {
    ...bot,
    ...Object.fromEntries(
      [...(savedBotFields.get(bot.name) ?? [])]
        .filter(([, field]) => field.completed > request)
        .map(([key, field]) => [key, field.value])
    )
  }
}

function saveEditedFields(bot: Bot, patch: BotUpdatePatch, request: number): Partial<Bot> {
  const fields = savedBotFields.get(bot.name) ?? new Map<keyof Bot, SavedBotField>()

  const edited = Object.keys(patch).filter(key => {
    const field = key as keyof BotUpdatePatch

    return (
      patch[field] !== undefined &&
      Object.hasOwn(bot, field) &&
      (fields.get(field)?.request ?? 0) < request
    )
  }) as (keyof Bot)[]

  if (!edited.length) {
    return {}
  }

  // updated_at is bookkeeping, not a monotonic server version.
  if (Object.hasOwn(bot, 'updated_at') && (fields.get('updated_at')?.request ?? 0) < request) {
    edited.push('updated_at')
  }

  const completed = ++botsRequest

  for (const key of edited) {
    fields.set(key, { completed, request, value: bot[key] })
  }

  savedBotFields.set(bot.name, fields)

  return Object.fromEntries(edited.map(key => [key, bot[key]]))
}

function forgetBot(name: string, request: number): void {
  removedBots.set(name, request)
  savedBotFields.delete(name)
}

export const useBots = create<BotsState>((set, get) => ({
  byName: {},
  error: null,
  loaded: false,
  loading: false,
  order: [],

  async refresh() {
    const request = ++botsRequest
    const revision = transcriptRevision()

    const archives = new Map(
      [
        ...new Set([
          ...Object.keys(get().byName),
          ...Object.keys(useSections.getState().idsByBot),
          ...Object.values(useTranscripts.getState().bySession).flatMap(transcript =>
            transcript.bot ? [transcript.bot] : []
          )
        ])
      ].map(name => [name, archivedScope(name)])
    )

    latestBotsRefresh = request
    set({ error: null, loading: true })

    try {
      const result = await botsList()

      if (fullBotsRequest > request) {
        return
      }

      fullBotsRequest = request
      const preserve = (name: string) => (botRequests.get(name) ?? 0) > request
      // A full reply is authoritative only for scopes without a newer accepted reply or edit.
      const returned = indexBots(result.bots ?? []).byName

      for (const name of new Set([...Object.keys(get().byName), ...Object.keys(returned)])) {
        if (!preserve(name)) {
          if (!returned[name]) {
            forgetBot(name, request)
          }

          clearBotAnswers(name, returned[name], revision, archives.get(name), request)
        }
      }

      set(state => {
        const indexed = indexBots(
          (result.bots ?? [])
            .filter(bot => !preserve(bot.name))
            .map(bot => withSavedFields(bot, request))
        )

        const byName = {
          ...indexed.byName,
          ...Object.fromEntries(Object.entries(state.byName).filter(([name]) => preserve(name)))
        }

        return {
          byName,
          order: [...new Set([...(result.bots ?? []).map(bot => bot.name), ...state.order])].filter(
            name => Boolean(byName[name])
          ),
          loaded: true
        }
      })
    } catch (error) {
      if (request === latestBotsRefresh) {
        set({ error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (request === latestBotsRefresh) {
        set({ loading: false })
      }
    }
  },

  async refreshOne(name) {
    const request = ++botsRequest
    const revision = transcriptRevision()
    const archived = archivedScope(name)

    try {
      const { bot } = await botsGet(name)

      if (fullBotsRequest > request || (botRequests.get(name) ?? 0) > request) {
        return
      }

      botRequests.set(name, request)
      clearBotAnswers(bot.name, bot, revision, archived, request)
      set(state => ({
        byName: { ...state.byName, [bot.name]: withSavedFields(bot, request) },
        order: state.order.includes(bot.name) ? state.order : [bot.name, ...state.order]
      }))
    } catch {
      await get().refresh()
    }
  },

  async create(input) {
    const result = await botsCreate(input)

    await get().refresh()

    return result
  },

  async update(name, patch) {
    const request = ++botsRequest
    const revision = transcriptRevision()
    const { bot } = await botsUpdate(name, patch)

    if ((removedBots.get(name) ?? 0) > request) {
      return bot
    }

    const edited = saveEditedFields(bot, patch, request)

    if (fullBotsRequest < request && (botRequests.get(name) ?? 0) < request) {
      botRequests.set(name, request)

      // Older daemons return catalog Idle here, even while other sessions are active.
      // A list/get reply or live event can retire that activity; a profile edit cannot.
      const idle = (bot.status ?? 'idle') === 'idle'

      if (!idle) {
        clearBotAnswers(bot.name, bot, revision)
      }

      set(state => {
        const current = state.byName[bot.name]

        return {
          byName: {
            ...state.byName,
            [bot.name]: withSavedFields(
              idle && current
                ? { ...bot, status: current.status, status_detail: current.status_detail }
                : bot,
              request
            )
          }
        }
      })
    } else if (get().byName[bot.name]) {
      // A newer accepted read can supersede runtime state while the edit is still saving.
      set(state => {
        const current = state.byName[bot.name]

        return current
          ? { byName: { ...state.byName, [bot.name]: { ...current, ...edited } } }
          : state
      })
    }

    return bot
  },

  async remove(name) {
    await botsDelete(name)
    const request = ++botsRequest
    botRequests.set(name, request)
    forgetBot(name, request)
    clearBotAnswers(name)

    // `/` reopens the last section; one of this bot's would show a bot that is gone.
    if (uiActions().lastSection?.bot === name) {
      uiActions().setLastSection(null)
    }

    set(state => {
      const byName = { ...state.byName }
      delete byName[name]

      return { byName, order: state.order.filter(item => item !== name) }
    })
  }
}))

export function botsActions(): BotsState {
  return useBots.getState()
}

export function selectBotList(state: BotsState): Bot[] {
  return state.order.map(name => state.byName[name]).filter((bot): bot is Bot => Boolean(bot))
}

export function useBotList(): Bot[] {
  return useBots(useShallow(selectBotList))
}

export function useBot(name: null | string): Bot | undefined {
  return useBots(state => (name ? state.byName[name] : undefined))
}
