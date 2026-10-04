/** Proof failures are recoverable authentication problems, not device revocation. */
export class DeviceProofError extends Error {
  constructor(
    public readonly code: string,
    public readonly serverTime?: number,
    public readonly proofTime?: number,
    public readonly retryAfterMs = 0
  ) {
    const minutes = Math.max(1, Math.round(Math.abs((serverTime ?? 0) - (proofTime ?? 0)) / 60))

    const message =
      code === 'dpop_clock_skew'
        ? `This device's clock differs from the daemon by ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Check both clocks, then retry.`
        : code === 'dpop_key_mismatch'
          ? 'The saved device key no longer matches this daemon. Pair it again.'
          : code === 'dpop_proof_required'
            ? 'The app could not load its saved key. Retry the connection.'
            : code === 'dpop_cache_full'
              ? 'The daemon is busy. Retry shortly.'
              : 'The daemon could not verify this app. Retry the connection.'

    super(message)
    this.name = 'DeviceProofError'
  }
}

export async function readDeviceProofError(response: Response): Promise<DeviceProofError | null> {
  if (response.ok) {
    return null
  }

  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    code?: string
    server_time?: number
    proof_time?: number
  } | null

  const retry = response.headers.get('retry-after')

  const delay =
    retry === null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()

  const retryAfterMs = Number.isFinite(delay) ? Math.max(0, delay) : 0

  if (body && isDeviceProofCode(body.code)) {
    return new DeviceProofError(body.code, body.server_time, body.proof_time, retryAfterMs)
  }

  if (response.headers.get('www-authenticate')?.includes('invalid_dpop_proof')) {
    return new DeviceProofError('invalid_dpop_proof', undefined, undefined, retryAfterMs)
  }

  return null
}

export function isDeviceProofCode(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    [
      'invalid_dpop_proof',
      'dpop_clock_skew',
      'dpop_key_mismatch',
      'dpop_proof_required',
      'dpop_cache_full'
    ].includes(code)
  )
}

/** Only codes and numeric details cross Electron IPC; renderer owns the copy. */
export type PairingReply<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: { code: string; serverTime?: number; proofTime?: number; retryAfterMs?: number }
    }
