/**
 * How a bot acts in a Discord server (`discord.rs` MODES), in the words both
 * apps show. Pure, so the mobile app shows the same choices.
 */

import type { DiscordMode } from './types'

export const DISCORD_MODES: { description: string; label: string; value: DiscordMode }[] = [
  {
    description:
      'Answers when someone mentions it or replies to it, and sees only those messages and the ones they reply to.',
    label: 'Mentions only',
    value: 'mentions'
  },
  {
    description:
      'Answers when someone mentions it or replies to it. Reads its channels, and other channels and threads in the server when it needs to.',
    label: 'Mentions, reads along',
    value: 'reads'
  },
  {
    description: 'Reads every channel it can see and joins in when it has something to add.',
    label: 'Active member',
    value: 'active'
  },
  {
    description:
      'Answers every message in every channel it can see, mentioned or not, except what is said to another of your bots.',
    label: 'Answers everyone',
    value: 'everyone'
  }
]

/** A mode's name, or the default's for a daemon from before modes. */
export function discordModeLabel(mode: DiscordMode | null | undefined): string {
  return (DISCORD_MODES.find(item => item.value === mode) ?? DISCORD_MODES[1]!).label
}

/** Whether a bot in this mode spends tokens on messages that don't mention it. */
export function discordModeListens(mode: DiscordMode | null | undefined): boolean {
  return mode === 'active' || mode === 'everyone'
}
