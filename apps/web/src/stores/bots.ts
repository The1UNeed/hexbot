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

function clearBotAnswers(name: string, bot?: Bot, throughRevision?: number): void {
  const scope = botAnswerScope(name, bot)
  useTranscripts
    .getState()
    .clearAnsweredWaiting(scope.sectionIds, scope.sessionIds, throughRevision)
}

let botsRequest = 0
let latestBotsRefresh = 0
let fullBotsRequest = 0
const botRequests = new Map<string, number>()

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
      const scopes = [...botRequests.keys()].filter(preserve).map(name => botAnswerScope(name))
      const sections = new Set(scopes.flatMap(scope => scope.sectionIds))
      const sessions = new Set(scopes.flatMap(scope => scope.sessionIds))
      const transcripts = useTranscripts.getState()

      // A full reply is authoritative only for scopes without a newer accepted reply or edit.
      transcripts.clearAnsweredWaiting(
        [],
        Object.values(transcripts.bySession)
          .filter(item => !sections.has(item.sectionId ?? '') && !sessions.has(item.sessionId))
          .map(item => item.sessionId),
        revision
      )
      set(state => {
        const indexed = indexBots((result.bots ?? []).filter(bot => !preserve(bot.name)))

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
        byName: { ...state.byName, [bot.name]: bot },
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

    if (fullBotsRequest < request && (botRequests.get(name) ?? 0) < request) {
      botRequests.set(name, ++botsRequest)
      clearBotAnswers(bot.name, bot, revision)
      set(state => ({ byName: { ...state.byName, [bot.name]: bot } }))
    }

    return bot
  },

  async remove(name) {
    await botsDelete(name)
    botRequests.set(name, ++botsRequest)
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
