import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import {
  passwordsDelete,
  passwordsList,
  passwordsReveal,
  passwordsSave,
  passwordsSetBots
} from '../../lib/api'
import type { Bot, PasswordLogin } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { usePasswords } from '../../stores/passwords'

import { PasswordsSettings } from './passwords'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  passwordsDelete: vi.fn().mockResolvedValue({}),
  passwordsList: vi.fn(),
  passwordsReveal: vi.fn(),
  passwordsSave: vi.fn(),
  passwordsSetBots: vi.fn()
}))

vi.mock('../../components/ui/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))

const schoology: PasswordLogin = {
  bots: null,
  has_code: true,
  has_password: true,
  id: 'login-1',
  notes: '',
  site: 'app.schoology.com',
  title: 'Schoology',
  updated_at: 1,
  url: 'https://app.schoology.com/login',
  username: 'alex'
}

const bot = (name: string, display_name: string, primary = false) =>
  ({ display_name, name, primary }) as Bot

describe('Settings, Passwords', () => {
  beforeEach(() => {
    vi.mocked(passwordsList).mockResolvedValue({
      bots: ['hexbot', 'owl'],
      logins: [schoology],
      store: 'keychain'
    })
    usePasswords.getState().reset()
    useBots.setState({
      byName: { hexbot: bot('hexbot', 'HexBot', true), owl: bot('owl', 'Owl') },
      order: ['owl', 'hexbot']
    })
  })

  it('lists logins with who may use them and where the key is kept', async () => {
    render(<PasswordsSettings />)
    const row = await screen.findByTestId('password-login-1')
    expect(within(row).getByText('Schoology')).toBeVisible()
    expect(within(row).getByText('app.schoology.com · alex')).toBeVisible()
    expect(within(row).getByText('Every bot')).toBeVisible()
    expect(
      screen.getByText("The vault's key is in the keychain of the daemon's computer.")
    ).toBeVisible()
  })

  it('shows the password only when asked, and shares with chosen bots', async () => {
    vi.mocked(passwordsReveal).mockResolvedValue({
      code: { code: '123456', valid_for: 20 },
      password: 'hunter2'
    })
    let answer: (value: { login: PasswordLogin }) => void = () => undefined
    vi.mocked(passwordsSetBots).mockReturnValue(new Promise(resolve => (answer = resolve)))
    render(<PasswordsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Schoology/ }))
    expect(screen.queryByText('hunter2')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(await screen.findByText('hunter2')).toBeVisible()
    expect(screen.getByText('123456')).toBeVisible()
    expect(passwordsReveal).toHaveBeenCalledWith('login-1')

    // Every bot is on; taking HexBot away names the rest.
    const bots = screen.getByRole('group', { name: 'Bots that use Schoology' })
    fireEvent.click(within(bots).getByRole('button', { name: 'HexBot' }))
    await waitFor(() => expect(passwordsSetBots).toHaveBeenCalledWith('login-1', ['owl']))
    // Until it saves, no second change can start from the old list.
    expect(within(bots).getByRole('button', { name: 'Owl' })).toBeDisabled()
    answer({ login: { ...schoology, bots: ['owl'] } })
    expect(await screen.findByText('Give to every bot')).toBeVisible()
    expect(screen.getByTestId('password-login-1')).toHaveTextContent('Owl')
  })

  it('adds a login and deletes one', async () => {
    const added = {
      ...schoology,
      has_code: false,
      id: 'login-2',
      title: 'Example',
      url: 'https://example.com',
      site: 'example.com'
    }

    vi.mocked(passwordsSave).mockResolvedValue({ login: added })
    render(<PasswordsSettings />)
    await screen.findByTestId('password-login-1')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: ' https://example.com ' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(save)
    await waitFor(() =>
      expect(passwordsSave).toHaveBeenCalledWith({
        notes: '',
        password: 'pw',
        title: '',
        url: 'https://example.com',
        username: ''
      })
    )
    expect(await screen.findByTestId('password-login-2')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /Schoology/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(passwordsDelete).toHaveBeenCalledWith('login-1'))
    await waitFor(() => expect(screen.queryByTestId('password-login-1')).toBeNull())
  })

  it('says what to do when there are none', async () => {
    vi.mocked(passwordsList).mockResolvedValue({ bots: [], logins: [], store: null })
    render(<PasswordsSettings />)
    expect(await screen.findByText(/No passwords yet/)).toBeVisible()
  })
})
