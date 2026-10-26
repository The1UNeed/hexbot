import { act, renderHook } from '@testing-library/react'

import { useUi } from '../stores/ui'

import { CUES, playCue, useTurnCues } from './sounds'

/** Frequencies of the notes started, in order. */
const started: number[] = []

const node = () => ({ connect: (next: unknown) => next, disconnect: vi.fn() })

class FakeAudio {
  currentTime = 0
  destination = {}
  state = 'running'
  createGain() {
    return {
      ...node(),
      gain: { exponentialRampToValueAtTime: vi.fn(), setValueAtTime: vi.fn(), value: 1 }
    }
  }
  createOscillator() {
    const tone = {
      ...node(),
      frequency: { value: 0 },
      start: () => started.push(tone.frequency.value),
      stop: vi.fn(),
      type: 'sine'
    }

    return tone
  }
}

beforeEach(() => {
  started.length = 0
  vi.stubGlobal('AudioContext', FakeAudio)
  act(() => useUi.getState().setSounds(true))
})

afterEach(() => {
  act(() => useUi.getState().setSounds(false))
  vi.unstubAllGlobals()
})

const notes = (cue: keyof typeof CUES) => CUES[cue].map(note => note.hz)

describe('sound cues', () => {
  it('plays nothing until the user turns sounds on', () => {
    act(() => useUi.getState().setSounds(false))
    playCue('done')
    expect(started).toEqual([])
  })

  it('stays silent while the window is hidden', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    playCue('done')
    expect(started).toEqual([])
    hidden.mockRestore()
  })

  it('cues a turn starting, finishing and asking, but not opening or switching conversations', () => {
    const { rerender } = renderHook(props => useTurnCues(props.id, props), {
      initialProps: { id: 'a', streaming: true, waiting: 0 }
    })

    expect(started).toEqual([])

    rerender({ id: 'a', streaming: false, waiting: 0 })
    expect(started).toEqual(notes('done'))

    started.length = 0
    rerender({ id: 'a', streaming: true, waiting: 0 })
    expect(started).toEqual(notes('start'))

    started.length = 0
    rerender({ id: 'a', streaming: true, waiting: 1 })
    expect(started).toEqual(notes('ask'))

    started.length = 0
    rerender({ id: 'a', streaming: true, waiting: 0 })
    rerender({ id: 'b', streaming: false, waiting: 0 })
    expect(started).toEqual([])
  })

  it('does not chime when a turn fails', () => {
    const { rerender } = renderHook(props => useTurnCues('a', props), {
      initialProps: { failed: false, streaming: true, waiting: 0 }
    })

    rerender({ failed: true, streaming: false, waiting: 0 })
    expect(started).toEqual([])
  })

  it('silently establishes the baseline after an asynchronous conversation restore', () => {
    const { rerender } = renderHook(props => useTurnCues('a', props), {
      initialProps: { ready: false, streaming: false, waiting: 0 }
    })

    rerender({ ready: false, streaming: true, waiting: 1 })
    rerender({ ready: true, streaming: true, waiting: 1 })
    expect(started).toEqual([])

    rerender({ ready: true, streaming: true, waiting: 2 })
    expect(started).toEqual(notes('ask'))
  })
})
