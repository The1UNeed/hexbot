'use server'

import { currentClerkUserId } from '@/lib/auth'
import { getStore } from '@/lib/runtime'
import { hashToken, randomToken } from '@/lib/tokens'

export interface AuthorizeResult {
  error?: string
  href?: string
}

export async function authorizeClient(
  _previous: AuthorizeResult,
  formData: FormData
): Promise<AuthorizeResult> {
  const userId = await currentClerkUserId()
  if (!userId) return { error: 'Sign in before connecting Hexbot.' }

  const state = String(formData.get('state') ?? '')
  const device = String(formData.get('device') ?? '')
  if (!state || !device || state.length > 256 || device.length > 100)
    return { error: 'The authorization request is invalid or expired.' }

  const user = await getStore().getOrCreateUser(userId)
  const token = randomToken('hxc_')
  await getStore().createClientSession({
    userId: user.id,
    tokenHash: hashToken(token),
    deviceName: device
  })
  return {
    href: `hexbot://connect?state=${encodeURIComponent(state)}#session=${encodeURIComponent(token)}`
  }
}
