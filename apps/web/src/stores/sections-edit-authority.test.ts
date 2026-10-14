import type { GatewayEvent } from '@hermes/shared'

import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Section } from '../lib/types'

import { clearDeletedSections, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

type Edit = 'archive' | 'unarchive' | 'rename'

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise<unknown>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

function fixture(edit: Edit, archivedAt: null | number = edit === 'unarchive' ? 1 : null) {
  const row = {
    id: 'target',
    bot: 'owl',
    title: 'Original',
    title_by: null,
    archived_at: archivedAt,
    live_session_id: 'original-live',
    preview: 'Original preview',
    message_count: 1
  } as Section

  const editing = deferred()

  const state = {
    row,
    applied: row,
    failList: false,
    heldList: null as ReturnType<typeof deferred> | null,
    heldOpen: null as ReturnType<typeof deferred> | null,
    listed: null as Section[] | null
  }

  clearDeletedSections()
  useSections.setState({
    byId: { target: row },
    idsByBot: { owl: ['target'] },
    liveSessionId: { target: 'original-live' },
    sendingTitles: {}
  })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })

  const call = vi.fn(async (method: string) => {
    if (method === `hexbot.sections.${edit}`) {
      // The native edit is applied before its RPC response reaches this client.
      state.row = {
        ...state.row,
        ...(edit === 'rename'
          ? { title: 'Local name', title_by: null }
          : { archived_at: edit === 'archive' ? 2 : null })
      }
      state.applied = state.row

      return editing.promise
    }

    if (method === 'hexbot.sections.list') {
      if (state.failList) {
        throw new Error('Read unavailable')
      }

      return state.heldList?.promise ?? { sections: state.listed ?? [state.row] }
    }

    if (method === 'hexbot.sections.open') {
      return state.heldOpen?.promise ?? { section: state.row, messages: [] }
    }

    throw new Error(`Unexpected ${method}`)
  })

  setActiveRpc({ call } as never)

  const begin = () =>
    edit === 'rename'
      ? useSections.getState().rename('target', 'Local name')
      : useSections.getState()[edit]('target')

  const changed = (bot?: string) => {
    let refreshing!: Promise<void>
    routeEvent(
      { type: 'hexbot.sections.changed', payload: { id: 'target', bot: 'owl' } } as GatewayEvent,
      {
        refreshSections: () => {
          refreshing = useSections.getState().refresh({ bot })
        },
        refreshBots: vi.fn()
      }
    )

    return refreshing
  }

  const remote = () => {
    state.row = {
      ...state.row,
      title: 'Other device',
      title_by: null,
      archived_at: edit === 'unarchive' ? 3 : null,
      preview: 'Fresh preview',
      message_count: 4
    }

    return state.row
  }

  const finish = async (saving: Promise<void>) => {
    editing.resolve({ section: state.applied })
    await saving
  }

  return { state, call, begin, changed, remote, finish }
}

afterEach(() => {
  setActiveRpc(null)
  resetTranscriptEffects()
})

const catalogOrders = [
  ['older', 'catalog', 'newer'],
  ['older', 'newer', 'catalog'],
  ['catalog', 'older', 'newer'],
  ['catalog', 'newer', 'older'],
  ['newer', 'older', 'catalog'],
  ['newer', 'catalog', 'older']
] as const

it.each([undefined, 'owl'])(
  'stamps catalog metadata actually installed into an unloaded row in scope %s',
  async bot => {
    const f = fixture('rename')
    useSections.setState({ byId: {}, idsByBot: {} })
    const saving = f.begin()
    f.state.row = { ...f.state.row, title: 'Catalog name' }
    const catalog = f.state.row
    f.state.heldList = deferred()
    const reading = f.changed(bot)
    f.state.row = { ...f.state.row, live_session_id: 'new-live' }
    await useSections.getState().openThread('target', 'cat')

    // Opening the thread establishes a newer binding without installing a catalog row.
    expect(useSections.getState().byId.target).toBeUndefined()
    f.state.heldList.resolve({ sections: [catalog] })
    await reading
    await f.finish(saving)

    expect(useSections.getState().byId.target).toMatchObject({
      ...catalog,
      live_session_id: 'new-live'
    })
    expect(useSections.getState().liveSessionId.target).toBe('new-live')
  }
)

describe.each([
  ['rename', 'archive'],
  ['rename', 'unarchive'],
  ['archive', 'rename'],
  ['unarchive', 'rename']
] as const)('catalog between %s and %s', (olderEdit, newerEdit) => {
  it.each(
    ([undefined, 'owl'] as const).flatMap(bot =>
      catalogOrders.map(order => ({ bot, order, label: order.join('/') }))
    )
  )('keeps both fields in scope $bot when replies finish $label', async ({ bot, order }) => {
    const f = fixture(olderEdit, olderEdit === 'unarchive' || newerEdit === 'unarchive' ? 1 : null)
    const olderSave = f.begin()
    const catalog = f.state.row
    f.state.heldList = deferred()
    const reading = f.changed(bot)
    const newerReply = deferred()

    const current = {
      ...f.state.row,
      ...(newerEdit === 'rename'
        ? { title: 'Second name' }
        : { archived_at: newerEdit === 'archive' ? 3 : null })
    }

    f.call.mockImplementationOnce(async () => {
      f.state.row = current

      return newerReply.promise
    })

    const newerSave =
      newerEdit === 'rename'
        ? useSections.getState().rename('target', 'Second name')
        : useSections.getState()[newerEdit]('target')

    const finish = {
      older: () => f.finish(olderSave),
      newer: async () => {
        newerReply.resolve({ section: current })
        await newerSave
      },
      catalog: async () => {
        f.state.heldList!.resolve({
          sections: [catalog, { ...catalog, id: 'catalog-sibling', title: 'Catalog sibling' }]
        })
        await reading
      }
    }

    for (const reply of order) {
      await finish[reply]()
    }

    expect(useSections.getState().byId.target).toMatchObject(current)
    expect(useSections.getState().byId['catalog-sibling']?.title).toBe('Catalog sibling')
    expect(useSections.getState().liveSessionId.target).toBe('original-live')
  })
})

describe.each(['archive', 'rename'] as const)('overlapping fields after %s', edit => {
  it.each(['older first', 'newer first'] as const)(
    'keeps both successful edits when ACKs finish %s',
    async order => {
      const f = fixture(edit)
      const olderSave = f.begin()
      const newerReply = deferred()

      const current = {
        ...f.state.row,
        ...(edit === 'archive' ? { title: 'New name' } : { archived_at: 3 })
      }

      f.call.mockImplementationOnce(async () => {
        f.state.row = current

        return newerReply.promise
      })

      const newerSave =
        edit === 'archive'
          ? useSections.getState().rename('target', 'New name')
          : useSections.getState().archive('target')

      const finishNewer = async () => {
        newerReply.resolve({ section: current })
        await newerSave
      }

      if (order === 'older first') {
        await f.finish(olderSave)
        await finishNewer()
      } else {
        await finishNewer()
        await f.finish(olderSave)
      }

      expect(useSections.getState().byId.target).toMatchObject(current)
    }
  )
})

describe.each(['archive', 'unarchive', 'rename'] as const)('delayed %s response', edit => {
  it.each(['older first', 'newer first'] as const)(
    'keeps the newer same-field edit when ACKs finish %s',
    async order => {
      const f = fixture(edit)
      const olderSave = f.begin()
      const newerReply = deferred()

      const current = {
        ...f.state.row,
        ...(edit === 'rename'
          ? { title: 'New name' }
          : { archived_at: edit === 'archive' ? null : 3 })
      }

      f.call.mockImplementationOnce(async () => {
        f.state.row = current

        return newerReply.promise
      })

      const newerSave =
        edit === 'rename'
          ? useSections.getState().rename('target', 'New name')
          : useSections.getState()[edit === 'archive' ? 'unarchive' : 'archive']('target')

      const finishNewer = async () => {
        newerReply.resolve({ section: current })
        await newerSave
      }

      if (order === 'older first') {
        await f.finish(olderSave)
        await finishNewer()
      } else {
        await finishNewer()
        await f.finish(olderSave)
      }

      expect(useSections.getState().byId.target).toMatchObject(current)
    }
  )

  it.each([undefined, 'owl'])(
    'keeps newer accepted changed-event metadata in the %s scope',
    async bot => {
      const f = fixture(edit)
      const saving = f.begin()
      const current = f.remote()
      await f.changed(bot)
      await f.finish(saving)

      expect(useSections.getState().byId.target).toEqual(current)
      expect(f.call).toHaveBeenCalledWith('hexbot.sections.list', {
        include_archived: true,
        bot
      })
    }
  )

  it.each([undefined, 'owl'])('accepts the edit after a newer %s read fails', async bot => {
    const f = fixture(edit)
    const saving = f.begin()
    f.state.failList = true
    await f.changed(bot)
    await f.finish(saving)

    expect(useSections.getState().byId.target).toMatchObject(f.state.applied)
  })

  it('accepts the edit while a newer read is merely pending', async () => {
    const f = fixture(edit)
    const saving = f.begin()
    f.state.heldList = deferred()
    const reading = f.changed('owl')
    await f.finish(saving)
    f.state.heldList.resolve({ sections: [f.state.applied] })
    await reading

    expect(useSections.getState().byId.target).toMatchObject(f.state.applied)
  })

  it.each(['owl', 'cat'])(
    'does not let accepted metadata for another %s section cancel the edit',
    async bot => {
      const f = fixture(edit)
      const saving = f.begin()
      f.state.listed = [{ ...f.state.row, id: 'sibling', bot, title: 'Sibling' }]
      await f.changed(bot)
      await f.finish(saving)

      expect(useSections.getState().byId.target).toMatchObject(f.state.applied)
      expect(useSections.getState().byId.sibling?.title).toBe('Sibling')
    }
  )

  it.each([undefined, 'owl'])(
    'preserves completed metadata against an older %s snapshot and loads siblings',
    async bot => {
      const f = fixture(edit)
      const original = f.state.row
      f.state.heldList = deferred()
      const reading = f.changed(bot)
      const saving = f.begin()
      await f.finish(saving)
      f.state.heldList.resolve({
        sections: [original, { ...original, id: 'sibling', title: 'Sibling' }]
      })
      await reading

      expect(useSections.getState().byId.target).toMatchObject(f.state.applied)
      expect(useSections.getState().byId.sibling?.title).toBe('Sibling')
    }
  )

  it('preserves a fresh open binding while applying the delayed edited field', async () => {
    const f = fixture(edit)
    const saving = f.begin()
    f.remote()
    f.state.row = { ...f.state.row, live_session_id: 'new-live' }
    const opened = await useSections.getState().open('target')
    await f.finish(saving)

    expect(useSections.getState().byId.target).toMatchObject({
      ...f.state.row,
      ...(edit === 'rename'
        ? { title: f.state.applied.title, title_by: f.state.applied.title_by }
        : { archived_at: f.state.applied.archived_at })
    })
    expect(opened.liveSessionId).toBe('new-live')
    expect(useSections.getState().liveSessionId.target).toBe('new-live')
  })

  it('does not replace a newer successful reverse edit with the old response', async () => {
    const f = fixture(edit)
    const saving = f.begin()

    const current = {
      ...f.state.row,
      ...(edit === 'rename'
        ? { title: 'New name' }
        : { archived_at: edit === 'archive' ? null : 3 })
    }

    f.call.mockImplementationOnce(async () => ({ section: current }))

    if (edit === 'rename') {
      await useSections.getState().rename('target', 'New name')
    } else {
      await useSections.getState()[edit === 'archive' ? 'unarchive' : 'archive']('target')
    }

    await f.finish(saving)
    expect(useSections.getState().byId.target).toMatchObject(current)
  })
})
