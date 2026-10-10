import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setActiveRpc } from '../../lib/rpc'

import { MemoryEditor, NotesBlock } from './memory'

const today = '2026-10-07'

const listed = (text: string) => ({
  cap: 4000,
  days: [{ date: today, text }],
  retention_days: 30,
  today
})

const conflict = () => Object.assign(new Error('Notes changed elsewhere.'), { code: 4209 })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, reject, resolve }
}

function rpc(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) =>
    handler(method, params)
  )

  setActiveRpc({ call } as never)

  return call
}

function edit(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

afterEach(() => {
  setActiveRpc(null)
  vi.restoreAllMocks()
})

describe('notes conflicts', () => {
  it.each([
    ['Plan', 'Planet', 'My plan', null],
    ['Plan  \n', 'Plan\n  New line\nNext', 'My plan', 'My plan\n  New line\nNext'],
    ['Plan', 'My plan', 'My plan', 'My plan'],
    ['Plan', '', 'My plan', null]
  ])('merges only complete appended lines: %j to %j', async (loaded, current, draft, merged) => {
    let reads = 0

    const call = rpc((method, params) => {
      if (method.endsWith('.list')) {
        return listed(reads++ ? current : loaded)
      }

      if (params.expected === loaded) {
        throw conflict()
      }

      return { date: today, text: params.text }
    })

    render(<NotesBlock bot="scout" />)
    await screen.findByRole('textbox')
    edit(draft)

    if (merged === null) {
      expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is kept')
      expect(screen.getByRole('textbox')).toHaveValue(draft)
    } else {
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
      expect(screen.getByRole('textbox')).toHaveValue(merged)
    }

    const writes = call.mock.calls.filter(([method]) => method.endsWith('.set'))
    expect(writes).toHaveLength(merged !== null && current !== draft ? 2 : 1)

    if (writes.length === 2) {
      expect(writes[1]?.[1]).toEqual({ bot: 'scout', date: today, expected: current, text: merged })
    }
  })

  it('keeps the draft if the merge retry also conflicts', async () => {
    let reads = 0
    rpc(method => {
      if (method.endsWith('.list')) {
        return listed(reads++ ? 'Plan\nBot note' : 'Plan')
      }

      throw conflict()
    })
    render(<NotesBlock bot="scout" />)
    await screen.findByRole('textbox')
    edit('My plan')
    await screen.findByRole('alert')
    expect(screen.getByRole('textbox')).toHaveValue('My plan')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('refuses a stale delete and keeps the editor and draft', async () => {
    const call = rpc(method => {
      if (method.endsWith('.list')) {
        return listed('Plan')
      }

      throw conflict()
    })

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<NotesBlock bot="scout" />)
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'My draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Notes changed elsewhere')
    expect(call).toHaveBeenCalledWith('hexbot.memory.notes.delete', {
      bot: 'scout',
      date: today,
      expected: 'Plan'
    })
    expect(screen.getByRole('textbox')).toHaveValue('My draft')
  })

  it('reloads a stale delete, keeps the selected day and draft, then deletes fresh text', async () => {
    let reads = 0
    let deletes = 0
    const yesterday = '2026-10-06'

    const call = rpc(method => {
      if (method.endsWith('.list')) {
        return {
          ...listed('Today'),
          days: [
            { date: today, text: 'Today' },
            { date: yesterday, text: reads++ ? 'Plan\nBot note' : 'Plan' }
          ]
        }
      }

      if (deletes++ === 0) {
        throw conflict()
      }

      return { deleted: true }
    })

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<NotesBlock bot="scout" />)
    await screen.findByRole('textbox')
    fireEvent.click(screen.getByRole('button', { name: /Yesterday/ }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(reads).toBe(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled())
    expect(screen.getByRole('button', { name: /Yesterday/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('textbox')).toHaveValue('My draft')
    expect(screen.getByRole('button', { name: /Yesterday/ })).toHaveTextContent('2 notes')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('hexbot.memory.notes.delete', {
      bot: 'scout', date: yesterday, expected: 'Plan\nBot note'
    }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Today'))
  })

  it.each([
    ['My draft', 'My draft\nBot note'],
    ['Plan', null]
  ])('saves draft %j after a stale delete without losing the new note', async (draft, merged) => {
    let reads = 0
    let text = 'Plan'

    const call = rpc((method, params) => {
      if (method.endsWith('.list')) {
        const shown = listed(text)

        if (reads++ === 0) {
          text = 'Plan\nBot note'
        }

        return shown
      }

      if (params.expected !== text) {
        throw conflict()
      }

      text = String(params.text)

      return { date: today, text }
    })

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<NotesBlock bot="scout" />)
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(reads).toBe(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled())

    if (merged === null) {
      expect(screen.getByRole('textbox')).toHaveValue('Plan\nBot note')
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
      expect(screen.queryByText(/since you started editing/)).toBeNull()

      return
    }

    expect(screen.getByRole('textbox')).toHaveValue(draft)
    expect(screen.getByText('Added since you started editing')).toBeInTheDocument()
    expect(screen.getByText('Bot note')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(merged))
    expect(text).toBe(merged)
    expect(screen.queryByText(/since you started editing/)).toBeNull()
    expect(call).toHaveBeenCalledWith('hexbot.memory.notes.set', {
      bot: 'scout', date: today, expected: 'Plan', text: draft
    })
  })

  it('shows retention errors and keeps an expired day draft', async () => {
    const message = 'Notes older than 30 days cannot be saved. Copy your draft to a more recent day.'
    rpc(method => {
      if (method.endsWith('.list')) {
        return listed('Plan')
      }

      throw Object.assign(new Error(message), { code: 4202 })
    })
    render(<NotesBlock bot="scout" />)
    await screen.findByRole('textbox')
    edit('My draft')
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('textbox')).toHaveValue('My draft')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it.each(['save', 'delete'])('prevents overlapping mutations during %s', async action => {
    const pending = deferred<unknown>()
    const call = rpc(method => (method.endsWith('.list') ? listed('Plan') : pending.promise))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<NotesBlock bot="scout" />)
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'My plan' } })
    fireEvent.click(screen.getByRole('button', { name: action === 'save' ? 'Save' : 'Delete' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(call.mock.calls.filter(([method]) => !method.endsWith('.list'))).toHaveLength(1)
    await act(async () => pending.resolve({ deleted: true, text: 'My plan' }))
  })
})

describe('notes bot switches', () => {
  it('replaces the loading skeleton with a list error', async () => {
    rpc(() => { throw new Error('Unavailable') })
    render(<NotesBlock bot="scout" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable')
    expect(screen.queryByRole('status', { name: 'Loading notes' })).toBeNull()
    expect(screen.queryByText('No notes yet')).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('ignores a superseded list %s', async outcome => {
    const pending = deferred<ReturnType<typeof listed>>()
    rpc((_, params) => (params.bot === 'scout' ? pending.promise : listed('Other bot')))
    const view = render(<NotesBlock bot="scout" />)
    view.rerender(<NotesBlock bot="other" />)
    expect(await screen.findByRole('textbox')).toHaveValue('Other bot')
    await act(async () => {
      if (outcome === 'resolve') {
        pending.resolve(listed('Old bot'))
      } else {
        pending.reject(new Error('Old error'))
      }
    })
    expect(screen.getByRole('textbox')).toHaveValue('Other bot')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['save', 'delete', 'conflict', 'reload', 'delete reload'])(
    'ignores superseded %s completions',
    async action => {
      const pending = deferred<unknown>()
      let reads = 0

      const call = rpc((method, params) => {
        if (params.bot === 'other') {
          return listed('Other bot')
        }

        if (method.endsWith('.list')) {
          return reads++ && action.endsWith('reload') ? pending.promise : listed('Plan')
        }

        if (action.endsWith('reload')) {
          throw conflict()
        }

        return pending.promise
      })

      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const view = render(<NotesBlock bot="scout" />)
      await screen.findByRole('textbox')

      if (action.startsWith('delete')) {
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      } else {
        edit('My plan')
      }

      if (action.endsWith('reload')) {
        await waitFor(() => expect(reads).toBe(2))
      }

      view.rerender(<NotesBlock bot="other" />)
      expect(await screen.findByRole('textbox')).toHaveValue('Other bot')
      await act(async () => {
        if (action === 'conflict') {
          pending.reject(conflict())
        } else {
          pending.resolve(
            action.endsWith('reload') ? listed('Plan\nBot note') : { deleted: true, text: 'My plan' }
          )
        }
      })
      expect(screen.getByRole('textbox')).toHaveValue('Other bot')
      expect(screen.queryByRole('alert')).toBeNull()
      expect(call.mock.calls.filter(([method]) => !method.endsWith('.list'))).toHaveLength(1)
    }
  )

  it('clears an error when switching bots', async () => {
    rpc((_, params) => {
      if (params.bot === 'scout') {
        throw new Error('Unavailable')
      }

      return listed('Other bot')
    })
    const view = render(<NotesBlock bot="scout" />)
    await screen.findByRole('alert')
    view.rerender(<NotesBlock bot="other" />)
    expect(await screen.findByRole('textbox')).toHaveValue('Other bot')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

it('counts code points and saves a full day of emoji', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<MemoryEditor cap={4000} label="Notes" onSave={save} value="" />)
  edit('😀'.repeat(4000))
  expect(screen.getByText('4000 / 4000')).toBeVisible()
  await waitFor(() => expect(save).toHaveBeenCalledWith('😀'.repeat(4000), ''))
  expect(screen.queryByRole('alert')).toBeNull()
})
