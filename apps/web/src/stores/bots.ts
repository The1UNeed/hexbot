/**
 * Bots, keyed by name and ordered by `last_activity_at` (the daemon already
 * sorts `hexbot.bots.list`). Refreshed on `hexbot.bots.changed`.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { botsCreate, botsDelete, botsGet, botsList, botsUpdate } from '../lib/api'
import type { Bot, BotCreateInput, BotUpdatePatch, Section } from '../lib/types'

import { useRooms } from './rooms'
import { useSections } from './sections'
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

/** Aggregate Idle also retires activity for sessions not opened yet. */
export function botIdleRevision(name?: string): number {
  return name ? (idleByBot.get(name) ?? 0) : idleRevision
}

function clearBotAnswers(name: string, bot?: Bot, throughRevision?: number): void {
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

  useTranscripts
    .getState()
    .clearAnsweredWaiting(scope.sectionIds, scope.sessionIds, throughRevision, {
      preserveWaiting: bot?.status === 'needs_you',
      idle: Boolean(bot && (bot.status ?? 'idle') === 'idle')
    })
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

          clearBotAnswers(name, returned[name], revision)
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

    try {
      const { bot } = await botsGet(name)

      if (fullBotsRequest > request || (botRequests.get(name) ?? 0) > request) {
        return
      }

      botRequests.set(name, request)
      clearBotAnswers(bot.name, bot, revision)
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
