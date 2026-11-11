import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

import {
  accountsSignInCancel,
  accountsSignInFinish,
  accountsSignInPoll,
  accountsSignInStart
} from '../lib/api'
import type { AccountSignIn } from '../lib/types'

import { AccountSignInPanel } from './account-sign-in'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  accountsSignInCancel: vi.fn(),
  accountsSignInFinish: vi.fn(),
  accountsSignInPoll: vi.fn(),
  accountsSignInStart: vi.fn()
}))

const google: AccountSignIn = {
  login_id: 'l1',
  message: '',
  mode: 'browser',
  redirect_uri: 'http://127.0.0.1:9119/oauth/google',
  service: 'google',
  status: 'pending',
  url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1'
}

describe('account sign-in', () => {
  let opened: string[]

  beforeEach(() => {
    opened = []
    vi.spyOn(window, 'open').mockImplementation(url => {
      opened.push(String(url))

      return null
    })
    vi.mocked(accountsSignInCancel).mockResolvedValue({ ...google, status: 'cancelled' })
    vi.mocked(accountsSignInPoll).mockResolvedValue(google)
  })

  afterEach(() => vi.restoreAllMocks())

  it('opens Google and finishes with the address a browser elsewhere ended on', async () => {
    vi.mocked(accountsSignInStart).mockResolvedValue(google)
    vi.mocked(accountsSignInFinish).mockResolvedValue({
      ...google,
      email: 'ana@example.com',
      status: 'done'
    })
    const onDone = vi.fn()
    render(<AccountSignInPanel onDone={onDone} service="google" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }))
    await screen.findByText(/Finish signing in on the Google page/)
    expect(opened).toEqual([google.url])

    const address = screen.getByLabelText('The address the browser ended on')
    fireEvent.change(address, {
      target: { value: ' http://127.0.0.1:9119/oauth/google?code=c&state=s ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() =>
      expect(accountsSignInFinish).toHaveBeenCalledWith(
        'l1',
        'http://127.0.0.1:9119/oauth/google?code=c&state=s'
      )
    )
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ email: 'ana@example.com' }))
    expect(screen.getByText('Signed in as ana@example.com.')).toBeVisible()
  })

  it('shows Microsoft’s code and finishes when the daemon says it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.mocked(accountsSignInStart).mockResolvedValue({
      code: 'ABCD-1234',
      login_id: 'l2',
      message: '',
      mode: 'device',
      service: 'microsoft',
      status: 'pending',
      url: 'https://microsoft.com/devicelogin'
    })
    vi.mocked(accountsSignInPoll).mockResolvedValue({
      login_id: 'l2',
      message: '',
      mode: 'device',
      service: 'microsoft',
      status: 'done',
      url: ''
    })
    const onDone = vi.fn()
    render(<AccountSignInPanel onDone={onDone} service="microsoft" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }))
    expect(await screen.findByTestId('account-code')).toHaveTextContent('ABCD-1234')
    // The page waits until the user has the code.
    expect(opened).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Copy code and open Microsoft' }))
    await waitFor(() => expect(opened).toEqual(['https://microsoft.com/devicelogin']))
    // No clipboard here: it says so instead of claiming it copied.
    expect(screen.getByRole('status')).toHaveTextContent('Type the code on the Microsoft page')
    expect(screen.queryByText('Copied')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    expect(accountsSignInPoll).toHaveBeenCalledWith('l2')
    expect(onDone).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('drops a poll answer for a sign-in the user stopped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const device = {
      code: 'ABCD-1234',
      login_id: 'l3',
      message: '',
      mode: 'device' as const,
      service: 'microsoft' as const,
      status: 'pending' as const,
      url: 'https://microsoft.com/devicelogin'
    }

    vi.mocked(accountsSignInStart).mockResolvedValue(device)
    let answer: (value: typeof device) => void = () => undefined
    vi.mocked(accountsSignInPoll).mockReturnValue(new Promise(resolve => (answer = resolve)))
    render(<AccountSignInPanel onDone={vi.fn()} service="microsoft" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }))
    await screen.findByTestId('account-code')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    // A poll is on its way when the user stops; its answer comes after.
    fireEvent.click(screen.getByRole('button', { name: 'Stop signing in' }))
    await act(async () => answer(device))
    expect(screen.queryByTestId('account-code')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible()
    vi.useRealTimers()
  })

  it('says why a sign-in could not start', async () => {
    vi.mocked(accountsSignInStart).mockRejectedValue(
      new Error('This Hexbot build has no Google sign-in of its own.')
    )
    render(<AccountSignInPanel onDone={vi.fn()} service="google" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no Google sign-in of its own')
  })
})
