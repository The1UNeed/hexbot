/** Proof failures are recoverable authentication problems, not device revocation. */
export class DeviceProofError extends Error {
  constructor(
    public readonly code: string,
    serverTime?: number,
    proofTime?: number
  ) {
    const minutes = Math.max(1, Math.round(Math.abs((serverTime ?? 0) - (proofTime ?? 0)) / 60))

    const message =
      code === 'dpop_clock_skew'
        ? `This device's clock differs from the daemon by ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Check both clocks, then retry.`
        : code === 'dpop_key_mismatch'
          ? 'The saved device key no longer matches this daemon. Sign in again.'
          : code === 'dpop_proof_required'
            ? 'The device key could not be loaded. Allow browser storage, then retry. If the key was deleted, sign in again.'
            : code === 'dpop_cache_full'
              ? 'The daemon is busy checking device proofs. Retry shortly.'
              : 'The daemon rejected the device proof. Retry the connection.'

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

  if (
    typeof body?.code === 'string' &&
    [
      'invalid_dpop_proof',
      'dpop_clock_skew',
      'dpop_key_mismatch',
      'dpop_proof_required',
      'dpop_cache_full'
    ].includes(body.code)
  ) {
    return new DeviceProofError(body.code, body.server_time, body.proof_time)
  }

  if (response.headers.get('www-authenticate')?.includes('invalid_dpop_proof')) {
    return new DeviceProofError('invalid_dpop_proof')
  }

  return null
}
