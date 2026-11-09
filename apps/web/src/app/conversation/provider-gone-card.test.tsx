import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { botsUpdate, providerModels, providersList } from '../../lib/api'
import type { Bot } from '../../lib/types'
import { useConnection } from '../../stores/connection'

import { providerGone, ProviderGoneCard } from './provider-gone-card'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  botsUpdate: vi.fn(),
  providerModels: vi.fn(),
  providersList: vi.fn()
}))

const bot = {
  avatar: null,
  created_at: 0,
  description: '',
  display_name: 'Scout',
  dream_enabled: true,
  last_activity_at: 0,
  model: 'anthropic/claude-sonnet-4',
  name: 'scout',
  owner_id: 'local',
  persona: '',
  provider: 'openrouter',
  provider_connected: false,
  sections_recent: [],
  sections_total: 0,
  skills: [],
  title: '',
  tools: [],
  updated_at: 0
} satisfies Bot

describe('provider gone card', () => {
  beforeEach(() => {
    useConnection.setState({ status: 'connected' })
    vi.mocked(providersList).mockResolvedValue({
      providers: [
        {
          auth_type: 'api_key',
          configured: false,
          id: 'openrouter',
          label: 'OpenRouter',
          models_source: 'live'
        },
        {
          auth_type: 'oauth_external',
          configured: true,
          id: 'openai-codex',
          label: 'OpenAI Codex',
          models_source: 'registry'
        }
      ]
    })
    vi.mocked(providerModels).mockResolvedValue([
      { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai-codex' }
    ])
    vi.mocked(botsUpdate).mockResolvedValue({
      bot: { ...bot, model: 'gpt-5.5', provider: 'openai-codex', provider_connected: true }
    })
  })

  it('applies only to a bot whose provider is gone', () => {
    expect(providerGone(bot)).toBe(true)
    expect(providerGone({ ...bot, provider_connected: true })).toBe(false)
    expect(providerGone({ ...bot, provider: null, provider_connected: null })).toBe(false)
    // An older daemon says nothing, so the card never shows.
    expect(providerGone({ ...bot, provider_connected: undefined })).toBe(false)
    expect(providerGone(undefined)).toBe(false)
  })

  it('names the gone provider, offers only connected ones, and moves the bot', async () => {
    render(<ProviderGoneCard bot={bot} />)

    expect(await screen.findByText('OpenRouter is no longer connected')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Use this model' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled()

    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }))
    expect(screen.queryByRole('option', { name: 'OpenRouter' })).toBeNull()
    fireEvent.click(await screen.findByRole('option', { name: 'OpenAI Codex' }))

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled())
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('option', { name: 'GPT-5.5' }))

    fireEvent.click(screen.getByRole('button', { name: 'Use this model' }))
    await waitFor(() =>
      expect(botsUpdate).toHaveBeenCalledWith('scout', { model: 'gpt-5.5', provider: 'openai-codex' })
    )
  })
})
