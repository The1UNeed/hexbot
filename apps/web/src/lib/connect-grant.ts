import { connectBaseUrl } from './connect-url'

export class ConnectRequestError extends Error {
  constructor(readonly status: number) {
    super(`Hex Connect request failed (${status})`)
  }
}

export async function fetchConnect(
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${connectBaseUrl()}${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    method: body ? 'POST' : 'GET'
  })

  if (!response.ok) {
    throw new ConnectRequestError(response.status)
  }

  return response.json()
}
