// Test driver policy, shared with portable failure controls.
import assert from 'node:assert/strict'
export async function startDevRuntime({ provision, startClients, startOwnedDaemon, ready, handshake }) {
  const env = await provision()
  await startClients(env)
  const owned = await startOwnedDaemon(env) // exactly one normal app bridge start
  const state = await ready()
  return handshake(state, owned)
}
export function assertSurvivingDesktop(completion) {
  assert.equal(completion.code, 1, 'Original sibling failure must remain primary')
  assert.equal(completion.exits.desktop, 0, 'Surviving desktop host must acknowledge completion')
  assert.equal(completion.kills.some(kill => kill.label === 'desktop'), false, 'Desktop fallback cannot count as completion')
  assert.equal(completion.diagnostics.some(line => line.includes('cleanup of desktop was not confirmed')), false)
}
export function remainingStartup(deadline, now = Date.now) {
  const remaining = deadline - now()
  assert(remaining > 0, 'Dev fixture startup budget exhausted')
  return remaining
}
