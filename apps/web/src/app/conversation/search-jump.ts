import { type RefObject, useEffect, useRef } from 'react'

import { useSearch } from '../../stores/search'

/** How long a found message stays marked. */
const FLASH_MS = 1600

/**
 * Scrolls the transcript to the message a search result asked for and marks
 * it for a moment. Rows carry `data-search-id`; `ready` changes when the
 * window widened, so a result older than the shown part lands once it renders.
 */
export function useSearchJump(viewport: RefObject<HTMLElement | null>, ready: unknown): void {
  const jump = useSearch(state => state.jump)
  // The request itself, not its nonce: a new conversation starts nonces over.
  const done = useRef<typeof jump>(null)

  useEffect(() => {
    const node = viewport.current

    if (!jump || !node || done.current === jump) {
      return
    }

    const row = node.querySelector<HTMLElement>(`[data-search-id="${CSS.escape(jump.id)}"]`)

    if (!row) {
      return
    }

    done.current = jump
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    row.classList.remove('hex-search-flash')
    // Restart the mark when the same row is found again.
    void row.offsetWidth
    row.classList.add('hex-search-flash')
    // Not cleared on a later render: the mark must come off even if the window widens again.
    window.setTimeout(() => row.classList.remove('hex-search-flash'), FLASH_MS)
  }, [jump, ready, viewport])
}
