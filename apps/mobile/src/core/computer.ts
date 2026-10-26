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
