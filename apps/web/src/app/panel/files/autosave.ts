import { useCallback, useEffect, useRef, useState } from 'react'

import { errorText } from '../../bot-settings/shared'

/** How long edits must pause before the file is saved. */
const SAVE_DELAY = 800

export type SaveStatus = 'error' | 'idle' | 'saved' | 'saving'

/** "Saving…", "Saved" or nothing, as the text editor says it. */
export const statusText = (status: SaveStatus) =>
  status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''

/**
 * Saves a file a moment after edits stop, one save at a time, each writing
 * what the file is when its turn comes. `flush` saves now and says whether
 * it landed; `dirty` is true from an edit until its save lands.
 */
export function useAutosave(
  write: () => Promise<void>,
  flushRef?: { current: (() => Promise<boolean>) | null }
) {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<null | string>(null)
  // Shown: an edit not saved yet, for a Save button.
  const [unsaved, setUnsaved] = useState(false)
  const pending = useRef(false)
  const timer = useRef<number>(undefined)
  const queue = useRef(Promise.resolve(true))
  const writeRef = useRef(write)
  writeRef.current = write

  const run = useCallback(async () => {
    if (!pending.current) {
      return true
    }

    pending.current = false
    setStatus('saving')

    try {
      await writeRef.current()
      setError(null)
      setStatus('saved')
      setUnsaved(pending.current)

      return true
    } catch (cause) {
      // The edit stays; the next one, or a flush, tries again.
      pending.current = true
      setError(errorText(cause))
      setStatus('error')

      return false
    }
  }, [])

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    queue.current = queue.current.then(run)

    return queue.current
  }, [run])

  const schedule = useCallback(() => {
    pending.current = true
    setUnsaved(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY)
  }, [flush])

  /** An edit saved only by `flush`, as a picture is with Save. */
  const mark = useCallback(() => {
    pending.current = true
    setUnsaved(true)
    setStatus('idle')
  }, [])

  useEffect(() => {
    if (!flushRef) {
      return
    }

    flushRef.current = flush

    return () => {
      flushRef.current = null
    }
  }, [flush, flushRef])

  // Leaving saves what is left.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)

      if (pending.current) {
        void queue.current.then(run)
      }
    },
    [run]
  )

  return { dirty: () => pending.current, error, flush, mark, schedule, status, unsaved }
}
