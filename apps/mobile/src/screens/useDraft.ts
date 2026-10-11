import { useState } from 'react'

/**
 * Local edits for a sheet, reset from `source` each time the sheet opens so
 * a cancelled edit never comes back.
 */
export function useDraft<T>(source: T, open: boolean) {
  const [draft, setDraft] = useState(source)
  const [wasOpen, setWasOpen] = useState(open)

  if (open !== wasOpen) {
    setWasOpen(open)

    if (open) {
      setDraft(source)
    }
  }

  return [draft, setDraft] as const
}
