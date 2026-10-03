import { connectBaseUrl } from './connect-url'

export async function fetchConnect(
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  let response = await fetch(`${connectBaseUrl()}${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    method: body ? 'POST' : 'GET'
  })

  // Older Connect deployments may reject the optional thumbprint field.
  if (response.status === 400 && body?.jkt) {
    const legacyBody = { ...body }
    delete legacyBody.jkt
    response = await fetch(`${connectBaseUrl()}${path}`, {
      body: JSON.stringify(legacyBody),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      method: 'POST'
    })
  }

  if (!response.ok) {
    throw new Error(`Hex Connect request failed (${response.status})`)
  }

  return response.json()
}
