import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot } from '../../lib/types'

import { needsPrimary, PrimaryChoice } from './primary-choice'

// jsdom never loads images, so the face is drawn as no PNG at all.
vi.mock('../../lib/avatar-builder', () => ({
  avatarPng: () => Promise.resolve(null),
  styleForName: () => ({})
}))

const bot = (name: string, primary?: boolean) =>
  ({ display_name: name.toUpperCase(), name, primary }) as Bot

describe('primary bot choice', () => {
  it('asks only a daemon that knows the primary bot and has none', () => {
    expect(needsPrimary([])).toBe(false)
    expect(needsPrimary([bot('owl')])).toBe(false)
    expect(needsPrimary([bot('owl', false), bot('fox', false)])).toBe(true)
    expect(needsPrimary([bot('owl', true), bot('fox', false)])).toBe(false)
  })

  it('makes the chosen bot primary', async () => {
    const call = vi.fn((method: string) =>
      Promise.resolve(method === 'hexbot.bots.list' ? { bots: [] } : { bot: bot('owl', true) })
    )

    setActiveRpc({ call } as never)

    render(<PrimaryChoice bots={[bot('owl', false)]} onCreated={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Add HexBot' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Make primary' })).toBeDisabled()
  })

  it('offers only promotion when a bot already has the handle', async () => {
    const call = vi.fn((method: string) =>
      Promise.resolve(
        method === 'hexbot.bots.list'
          ? { bots: [] }
          : { bot: bot('hexbot', true), section: { id: 'new' } }
      )
    )

    setActiveRpc({ call } as never)

    render(<PrimaryChoice bots={[bot('hexbot', false), bot('owl', false)]} onCreated={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Add HexBot' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Make primary' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.bots.set_primary', { name: 'hexbot' })
    )
    // Its older sections keep their tools, so a new one opens.
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.sections.create', { bot: 'hexbot' })
    )
  })

  it('adds HexBot and opens its section', async () => {
    const created = { bot: bot('hexbot', true), section: { id: 'general' } }

    const call = vi.fn((method: string) =>
      Promise.resolve(method === 'hexbot.bots.list' ? { bots: [] } : created)
    )

    setActiveRpc({ call } as never)
    const onCreated = vi.fn()

    render(<PrimaryChoice bots={[bot('owl', false)]} onCreated={onCreated} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add HexBot' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created.bot, created.section, true))
    expect(call).toHaveBeenCalledWith('hexbot.bots.create_primary', expect.any(Object))
  })
})
