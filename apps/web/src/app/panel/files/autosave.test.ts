import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAutosave } from './autosave'

describe('autosave', () => {
  afterEach(() => vi.useRealTimers())

  it('holds a waiting save while a new edit is typed, then saves both', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => {})
    const { result } = renderHook(() => useAutosave(write))

    act(() => result.current.schedule())
    // Typing starts in another cell before the first save's timer fires.
    act(() => result.current.hold())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(write).not.toHaveBeenCalled()
    expect(result.current.dirty()).toBe(true)

    // The typing is committed: one save writes everything.
    act(() => result.current.schedule())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(result.current.dirty()).toBe(false)
  })

  it('keeps typing guarded while a save already on its way lands', async () => {
    let land: () => void = () => {}
    const write = vi.fn(() => new Promise<void>(resolve => (land = resolve)))
    const { result } = renderHook(() => useAutosave(write))

    act(() => result.current.schedule())
    let flushed: Promise<boolean> = Promise.resolve(true)

    act(() => {
      flushed = result.current.flush()
    })
    await act(async () => {})
    // The save is writing; typing starts in another cell.
    act(() => result.current.hold())
    await act(async () => {
      land()
      await flushed
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(result.current.dirty()).toBe(true)

    // Escape: nothing to write, and the guard goes.
    act(() => result.current.settle())
    expect(result.current.dirty()).toBe(false)
  })
})
