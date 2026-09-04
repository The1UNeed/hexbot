import { act, render, screen } from '@testing-library/react'

import { ProviderPanel } from '../components/provider-panel'
import * as api from '../lib/api'

vi.mock('../lib/api', () => ({
  modelsList: vi.fn(),
  providersLoginCancel: vi.fn(() => Promise.resolve({})),
  providersLoginPoll: vi.fn(),
  providersLoginStart: vi.fn(),
  providersSetKey: vi.fn()
}))

const login = (status: string) => ({
  code: 'ABCD-1234',
  login_id: 'l1',
  message: '',
  provider: 'openai-codex',
  status,
  supported: true,
  url: 'https://auth.example/device'
})

describe('provider sign-in panel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.open = vi.fn()
  })
  afterEach(() => vi.useRealTimers())

  it('keeps polling without cancelling until the sign-in completes', async () => {
    vi.mocked(api.providersLoginStart).mockResolvedValue(login('pending') as never)
    vi.mocked(api.providersLoginPoll)
      .mockResolvedValueOnce(login('pending') as never)
      .mockResolvedValueOnce(login('done') as never)
    const onConfigured = vi.fn(() => Promise.resolve())
    render(
      <ProviderPanel
        onConfigured={onConfigured}
        provider={{
          auth_type: 'oauth_external',
          configured: false,
          id: 'openai-codex',
          label: 'ChatGPT',
          models_source: 'registry'
        }}
      />
    )

    await act(async () => {
      screen.getByTestId('provider-sign-in').click()
    })
    expect(screen.getByTestId('login-code')).toHaveTextContent('ABCD-1234')
    expect(window.open).toHaveBeenCalledWith(
      'https://auth.example/device',
      '_blank',
      'noopener,noreferrer'
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    expect(api.providersLoginCancel).not.toHaveBeenCalled()
    expect(screen.getByTestId('login-code')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    expect(onConfigured).toHaveBeenCalled()
    expect(api.providersLoginCancel).not.toHaveBeenCalled()
  })
})
