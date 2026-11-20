/**
 * This app's own computer as one of the user's computers (`machines.rs`).
 *
 * Only the desktop app connected to a daemon on another computer can offer
 * its computer, and only once the user allowed it there: the switch lives in
 * the Electron main process (apps/desktop/src/main/computer.ts), which asks
 * natively before it turns on and runs every request itself. The daemon can
 * neither turn it on nor reach past what it allows. This module only carries
 * the daemon's requests over the app's own connection and the answers back.
 */

import { useConnection } from '../stores/connection'

import { computersAttach, computersReply } from './api'
import { getBridge as bridge, type ComputerShare } from './bridge'
import type { ComputerRequest } from './types'

/** Whether this app can offer its computer at all: the desktop app, on another computer than the daemon. */
export function canOfferComputer(): boolean {
  return Boolean(bridge()?.computer) && useConnection.getState().target?.kind === 'remote'
}

let offered: ComputerShare | null = null

let offering: Promise<void> = Promise.resolve()

/**
 * Tell the daemon what this computer allows now. Called on every connect
 * and every change. Offers go one at a time, and each reads the switch when
 * it runs, so a stop while an earlier offer was on its way always reaches
 * the daemon last.
 */
export function offerThisComputer(): Promise<void> {
  offering = offering.catch(() => {}).then(offerNow)

  return offering
}

async function offerNow(): Promise<void> {
  const computer = bridge()?.computer

  if (!computer || !canOfferComputer() || useConnection.getState().status !== 'connected') {
    return
  }

  const current = await computer.state()

  // Nothing allowed and nothing offered on this connection: nothing to say.
  if (!current.terminal && !current.desktop && !offered) {
    return
  }

  try {
    await computersAttach({
      desktop: current.desktop,
      name: current.name,
      os: current.os,
      terminal: current.terminal
    })
    offered = current.terminal || current.desktop ? current : null
  } catch {
    // An older daemon has no computers; this computer simply stays off there.
    offered = null
  }
}

/**
 * A connection that ends, by a drop, a revoked device or a switch to
 * another daemon, takes the offer with it and stops what bots started
 * here. The next connect offers this computer again.
 */
export function connectionClosed(): void {
  offered = null
  void bridge()?.computer?.release?.()
}

let watching = false

/** Re-offer whenever the user changes the switch here, from Settings or the tray. */
export function watchThisComputer(): void {
  const computer = bridge()?.computer

  if (watching || !computer?.onState) {
    return
  }

  watching = true
  computer.onState(() => void offerThisComputer())
}

/** Run one request from the daemon in the main process and send its answer back. */
export async function handleComputerRequest(payload: Record<string, unknown>): Promise<void> {
  const id = typeof payload.request_id === 'string' ? payload.request_id : null
  const computer = bridge()?.computer

  if (!id) {
    return
  }

  // What bots started here ends: the user forgot this computer on the daemon
  // (offered again on the next connection or switch change), or this
  // connection replaced an older one (still offered, so a later stop or
  // switch change still reaches the daemon).
  if (payload.kind === 'release') {
    if (payload.reason !== 'replaced') {
      offered = null
    }

    try {
      await computer?.release?.()
      await computersReply(id, { result: { released: Boolean(computer?.release) } })
    } catch (error) {
      await computersReply(id, {
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => {})
    }

    return
  }

  // The user stopped the chat: that request's command ends. Nothing to answer.
  if (payload.kind === 'cancel') {
    if (typeof payload.cancels === 'string') {
      void computer?.cancel?.(payload.cancels)
    }

    return
  }

  if (!computer || !canOfferComputer()) {
    await computersReply(id, { error: 'This computer does not let bots use it.' }).catch(() => {})

    return
  }

  try {
    const result = await computer.run(payload as unknown as ComputerRequest)
    await computersReply(id, { result })
  } catch (error) {
    await computersReply(id, {
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => {})
  }
}
