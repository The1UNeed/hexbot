'use client'

import { useActionState } from 'react'
import { authorizeClient, type AuthorizeResult } from './actions'

const initialState: AuthorizeResult = {}

export function AuthorizeForm({ device, state }: { device: string; state: string }) {
  const [result, action, pending] = useActionState(authorizeClient, initialState)

  if (result.href) {
    return (
      <>
        <p>The connection is ready. Return to {device} to finish.</p>
        <a className="button" href={result.href}>
          Open Hexbot
        </a>
      </>
    )
  }

  return (
    <form action={action}>
      <input name="device" type="hidden" value={device} />
      <input name="state" type="hidden" value={state} />
      <button disabled={pending} type="submit">
        {pending ? 'Authorizing...' : 'Authorize and open Hexbot'}
      </button>
      {result.error ? (
        <p className="error" role="alert">
          {result.error}
        </p>
      ) : null}
    </form>
  )
}
