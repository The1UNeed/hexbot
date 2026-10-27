import type { ComputerQuality } from './types'

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
