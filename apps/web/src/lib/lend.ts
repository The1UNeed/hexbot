/**
 * This computer, lent to the daemon's bots by the desktop app. The page holds
 * the daemon connection, so it offers the computer on every connect and
 * relays each `hexbot.computer.request` to the app's main process, which
 * runs it (apps/desktop/src/main/computer.ts) and whose answer goes back as
 * `hexbot.computers.reply`. A plain browser lends nothing.
 */

import { getBridge, type LendState } from './bridge'
import { rpcCall } from './rpc'

/** Offer this computer if the user lends it; withdraw it if not. */
export async function offerComputer(state?: LendState): Promise<LendState | null> {
  const lend = getBridge()?.computer

  if (!lend) {
    return null
  }

  const current = state ?? (await lend.state())

  if (current.on) {
    await rpcCall('hexbot.computers.offer', {
      name: current.name,
      os: current.os,
      screen: current.screen
    })
  } else {
    await rpcCall('hexbot.computers.withdraw')
  }

  return current
}

/** Run one request the daemon sent for this computer and answer it. */
export async function answerRequest(payload: Record<string, unknown>): Promise<void> {
  const lend = getBridge()?.computer
  const id = payload.id

  if (typeof id !== 'string') {
    return
  }

  try {
    if (!lend) {
      throw new Error('This app cannot lend its computer.')
    }

    const result = await lend.run(payload)
    await rpcCall('hexbot.computers.reply', { id, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await rpcCall('hexbot.computers.reply', { error: message, id }).catch(() => {})
  }
}
