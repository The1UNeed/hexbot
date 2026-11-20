import type { Bot, Computer, ComputerQuality } from './types'

/** What a bot is doing on the computer, by `computer_use` action: "clicking". */
const COMPUTER: Record<string, string> = {
  click: 'clicking',
  double_click: 'clicking',
  drag: 'dragging',
  key: 'pressing keys',
  launch: 'opening an app',
  middle_click: 'clicking',
  move: 'moving the pointer',
  open: 'opening a page',
  right_click: 'clicking',
  screenshot: 'looking at the screen',
  scroll: 'scrolling',
  shell: 'running a command',
  type: 'typing',
  wait: 'waiting',
  windows: 'checking windows'
}

/** "Scout is clicking on the computer", or "Scout is using the computer". */
export function computerActivity(name: string, action?: string | null) {
  const doing = COMPUTER[action ?? '']
  return doing ? `${name} is ${doing} on the computer` : `${name} is using the computer`
}

/** The screen's quality on this phone, as the card lists it; as on the web. */
export const COMPUTER_QUALITIES: { label: string; value: ComputerQuality }[] = [
  { label: 'Auto', value: 'auto' },
  { label: '1080p · 60 fps', value: '1080p60' },
  { label: '1080p · 30 fps', value: '1080p30' },
  { label: '720p · 60 fps', value: '720p60' },
  { label: '720p · 30 fps', value: '720p30' }
]

/**
 * Web views play the screen's video only on a secure page: HTTPS, or the
 * daemon's own computer. A daemon paired at a plain http:// address on the
 * network cannot show it.
 */
export function screenPlays(origin: string) {
  const { hostname, protocol } = new URL(origin)
  return (
    protocol === 'https:' ||
    ['127.0.0.1', '[::1]', 'localhost'].includes(hostname) ||
    hostname.endsWith('.localhost')
  )
}

/** What the list of computers said, as the Computer card read it. */
export type ComputersListed = 'loading' | 'listed' | 'older' | { error: string }

/**
 * What a bot's Computer card shows of the bots' computer. A bot's Computer
 * use may be a desktop elsewhere, so the card waits for the list to say
 * whether it works here; only a daemon from before computers (`older`) goes
 * by the bot's tools.
 */
export function computerAccess(
  bot: Bot | undefined,
  list: ComputersListed,
  vm: Computer | undefined
): 'loading' | 'off' | 'enable' | 'screen' | { error: string } {
  if (!bot) return 'screen'
  if (list === 'older') return (bot.tools ?? []).includes('computer_use') ? 'screen' : 'enable'
  if (list === 'loading' || typeof list === 'object') return list
  if (!vm?.on) return 'off'
  return vm.desktop.bots.includes(bot.name) ? 'screen' : 'enable'
}

/**
 * The computers to show in Settings, Computers: only a list this connection
 * read, since grants may have changed while the phone was away.
 */
export function currentComputers(listed: ComputersListed, computers: Computer[] | null) {
  return listed === 'listed' ? computers : null
}

/**
 * Numbers reads of one thing so only the latest one's answer counts: `start`
 * returns whether that read is still the latest, and `drop` makes every read
 * on its way stale, as a reconnect or a daemon switch does.
 */
export function latestReads() {
  let count = 0
  return {
    drop() {
      count++
    },
    start() {
      const mine = ++count
      return () => mine === count
    }
  }
}

/**
 * A notice an action left, such as stopping bots on a computer that didn't
 * confirm, added to the unread ones: oldest first, each kept until its own
 * OK, so a later one never replaces or clears another.
 */
export function addNotice(notices: string[], note: string | null | undefined): string[] {
  return !note || notices.includes(note) ? notices : [...notices, note]
}
