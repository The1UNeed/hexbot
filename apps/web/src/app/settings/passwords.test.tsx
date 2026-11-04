import { JsonRpcGatewayError } from '@hermes/shared'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import {
  passwordsConnect,
  passwordsDelete,
  passwordsDisconnect,
  passwordsList,
  passwordsReveal,
  passwordsSave,
  passwordsSetBots
} from '../../lib/api'
import type { Bot, PasswordItem } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { usePasswords } from '../../stores/passwords'

import { PasswordsSettings } from './passwords'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  passwordsConnect: vi.fn(),
  passwordsDelete: vi.fn().mockResolvedValue({}),
  passwordsDisconnect: vi.fn().mockResolvedValue({ vault: { kind: 'local' } }),
  passwordsList: vi.fn(),
  passwordsReveal: vi.fn(),
  passwordsSave: vi.fn(),
  passwordsSetBots: vi.fn()
}))

vi.mock('../../components/ui/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))

const schoology: PasswordItem = {
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
    let answer: (value: { login: PasswordItem }) => void = () => undefined
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
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Login' }))
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

  it('makes an SSH key, shows its public key, and the private key only when asked', async () => {
    const github: PasswordItem = {
      bots: null,
      fingerprint: 'SHA256:GPeuPte1++Gywv986aVurpkbhakdHkMnkVHx0lvvGDY',
      has_code: false,
      has_passphrase: false,
      has_password: false,
      id: 'ssh-1',
      kind: 'ssh_key',
      notes: '',
      public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGou GitHub',
      site: null,
      title: 'GitHub',
      updated_at: 1,
      url: '',
      username: ''
    }

    vi.mocked(passwordsSave).mockResolvedValue({ login: github })
    vi.mocked(passwordsReveal).mockResolvedValue({
      passphrase: '',
      private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n'
    })
    render(<PasswordsSettings />)
    await screen.findByTestId('password-login-1')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'SSH key' }))
    expect(screen.getByText('New SSH key')).toBeVisible()
    // Hexbot makes the key unless one is pasted.
    expect(screen.queryByLabelText('Private key')).toBeNull()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'GitHub' } })
    fireEvent.click(save)
    await waitFor(() =>
      expect(passwordsSave).toHaveBeenCalledWith({
        generate: true,
        kind: 'ssh_key',
        notes: '',
        title: 'GitHub'
      })
    )
    const row = await screen.findByTestId('password-ssh-1')
    expect(within(row).getByText(/SSH key · SHA256:GPeu/)).toBeVisible()

    // Two kinds: the list can show one.
    fireEvent.click(screen.getByRole('button', { name: 'SSH keys' }))
    expect(screen.queryByTestId('password-login-1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByTestId('password-login-1')).toBeVisible()

    fireEvent.click(within(row).getByRole('button', { name: /GitHub/ }))
    expect(within(row).getByText(github.public_key!)).toBeVisible()
    expect(within(row).getByRole('button', { name: 'Copy public key' })).toBeVisible()
    expect(within(row).queryByText(/BEGIN OPENSSH/)).toBeNull()
    expect(within(row).queryByText('Passphrase')).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Show private key' }))
    expect(await within(row).findByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeVisible()
    expect(passwordsReveal).toHaveBeenCalledWith('ssh-1')
  })

  it('pastes an SSH key with its passphrase', async () => {
    vi.mocked(passwordsSave).mockRejectedValue(new Error("That passphrase doesn't open this key."))
    render(<PasswordsSettings />)
    await screen.findByTestId('password-login-1')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'SSH key' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Server' } })
    fireEvent.click(screen.getByRole('button', { name: 'Paste a key' }))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Private key'), { target: { value: 'KEY' } })
    fireEvent.change(screen.getByLabelText('Passphrase (if the key has one)'), {
      target: { value: 'pp' }
    })
    fireEvent.click(save)
    await waitFor(() =>
      expect(passwordsSave).toHaveBeenCalledWith({
        kind: 'ssh_key',
        notes: '',
        passphrase: 'pp',
        private_key: 'KEY',
        title: 'Server'
      })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent("doesn't open")

    // Back to Make a new key, the pasted key is not sent.
    fireEvent.click(screen.getByRole('button', { name: 'Make a new key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(passwordsSave).toHaveBeenLastCalledWith({
        generate: true,
        kind: 'ssh_key',
        notes: '',
        title: 'Server'
      })
    )
  })

  it('adds an API key, naming its variable from its name', async () => {
    const openai: PasswordItem = {
      bots: null,
      env: 'OPENAI_API_KEY',
      has_code: false,
      has_password: true,
      id: 'api-1',
      kind: 'api_key',
      notes: '',
      site: null,
      title: 'OpenAI',
      updated_at: 1,
      url: '',
      username: ''
    }

    vi.mocked(passwordsSave).mockResolvedValue({ login: openai })
    vi.mocked(passwordsReveal).mockResolvedValue({ key: 'sk-test' })
    render(<PasswordsSettings />)
    await screen.findByTestId('password-login-1')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'API key' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OpenAI' } })
    expect(screen.getByLabelText('Variable')).toHaveAttribute('placeholder', 'OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(passwordsSave).toHaveBeenCalledWith({
        env: '',
        key: 'sk-test',
        kind: 'api_key',
        notes: '',
        title: 'OpenAI',
        url: ''
      })
    )
    const row = await screen.findByTestId('password-api-1')
    expect(within(row).getByText('API key · OPENAI_API_KEY')).toBeVisible()
    fireEvent.click(within(row).getByRole('button', { name: /OpenAI/ }))
    expect(within(row).queryByText('sk-test')).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Show key' }))
    expect(await within(row).findByText('sk-test')).toBeVisible()
    // Searching finds a key by its variable.
    fireEvent.change(screen.getByLabelText('Search passwords'), { target: { value: 'openai_api' } })
    expect(screen.queryByTestId('password-login-1')).toBeNull()
    expect(screen.getByTestId('password-api-1')).toBeVisible()
  })

  it('connects Vaultwarden, asking for a two-step code when the account has one', async () => {
    const vault = {
      email: 'me@example.com',
      folder: 'Hexbot',
      kind: 'vaultwarden' as const,
      server: 'https://vault.example.com'
    }

    vi.mocked(passwordsConnect)
      .mockRejectedValueOnce(
        new JsonRpcGatewayError('This account uses two-step login.', { code: 4207 })
      )
      .mockResolvedValueOnce({ copied: 1, vault })
    render(<PasswordsSettings />)
    await screen.findByTestId('password-login-1')
    expect(screen.getByText('This daemon')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Use Vaultwarden' }))
    fireEvent.change(screen.getByLabelText('Vaultwarden address'), {
      target: { value: 'https://vault.example.com' }
    })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.com' } })
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'mp' } })
    expect(
      screen.getByRole('switch', { name: 'Copy the items saved on this daemon' })
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(passwordsConnect).toHaveBeenCalledWith({
        copy: true,
        email: 'me@example.com',
        password: 'mp',
        server: 'https://vault.example.com'
      })
    )
    fireEvent.change(await screen.findByLabelText('Two-step login code'), {
      target: { value: ' 123456 ' }
    })
    vi.mocked(passwordsList).mockResolvedValue({
      bots: [],
      logins: [schoology],
      store: 'keychain',
      vault
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(passwordsConnect).toHaveBeenLastCalledWith({
        code: '123456',
        copy: true,
        email: 'me@example.com',
        password: 'mp',
        server: 'https://vault.example.com'
      })
    )
    expect(await screen.findByText('Copied 1 item into the Hexbot folder.')).toBeVisible()
    expect(screen.getByText('me@example.com · vault.example.com')).toBeVisible()
    expect(
      screen.getByText(
        "Your Vaultwarden master password is in the keychain of the daemon's computer."
      )
    ).toBeVisible()

    // Disconnecting goes back to the vault on the daemon.
    vi.mocked(passwordsList).mockResolvedValue({
      bots: [],
      logins: [schoology],
      store: 'keychain',
      vault: { kind: 'local' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(passwordsDisconnect).toHaveBeenCalled())
    expect(await screen.findByText('This daemon')).toBeVisible()
  })

  it('says what to do when there are none', async () => {
    vi.mocked(passwordsList).mockResolvedValue({ bots: [], logins: [], store: null })
    render(<PasswordsSettings />)
    expect(await screen.findByText(/No passwords yet/)).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull()
  })
})
