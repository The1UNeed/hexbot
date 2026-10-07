/**
 * Where a tap on a bot lands. The home list reads like a chat list, so a bot
 * row continues its most recent section; "New section" asks for a fresh one,
 * reusing the bot's untouched section so asking twice never piles up empty
 * sections (the same rule as the desktop roster).
 */

import { router } from 'expo-router'

import { useDrafts } from '../stores/drafts'
import { isThread, sectionsActions, useSections } from '../stores/sections'

import { toMillis } from './time'
import type { Section } from './types'

export const touched = (section: Section, drafts: Record<string, string> = {}) =>
  section.message_count > 0 || Boolean(section.preview) || Boolean(drafts[section.id])

/** Sections a bot lists: touched, not archived, not Dreams, not a thread. */
export const listed = (section: Section, drafts: Record<string, string> = {}) =>
  touched(section, drafts) && !section.archived_at && section.title !== 'Dreams' && !isThread(section)

function sectionsOf(bot: string): Section[] {
  return Object.values(useSections.getState().byId)
    .filter(item => item.bot === bot)
    .sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at))
}

export function openSection(sectionId: string, mode: 'push' | 'replace' = 'push'): void {
  const href = { params: { section: sectionId }, pathname: '/chat/[section]' } as const

  if (mode === 'replace') {
    router.replace(href)
  } else {
    router.push(href)
  }
}

/** The bot's untouched section if it has one that still opens, else a new one. */
export async function freshSection(bot: string): Promise<Section> {
  await sectionsActions().refresh()

  const drafts = useDrafts.getState().byId
  const blank = sectionsOf(bot).find(item => !item.archived_at && !touched(item, drafts) && !isThread(item))
  // An empty section has no stored session, so it does not survive a daemon restart.
  const alive =
    blank &&
    (await sectionsActions()
      .open(blank.id)
      .then(() => true)
      .catch(() => false))

  if (blank && alive) {
    return blank
  }

  if (blank) {
    await sectionsActions()
      .remove(blank.id)
      .catch(() => undefined)
  }

  return sectionsActions().create(bot)
}

/** Continue the bot's latest conversation, or start its first. */
export async function openBot(bot: string): Promise<void> {
  await sectionsActions().refresh()

  const drafts = useDrafts.getState().byId
  const latest = sectionsOf(bot).find(item => listed(item, drafts))

  openSection(latest ? latest.id : (await freshSection(bot)).id)
}
