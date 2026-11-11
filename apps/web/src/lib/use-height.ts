import { useCallback, useState } from 'react'

/**
 * Tracks an element's height, for content that scrolls under floating glass:
 * the scroller pads itself by the chrome's height, so its last line can rest
 * clear of it while everything above still runs underneath. A callback ref,
 * so chrome that mounts after the first render (a room that loads, a footer
 * that appears) is measured too.
 */
export function useHeight<T extends HTMLElement>(): [(node: T | null) => () => void, number] {
  const [height, setHeight] = useState(0)

  const ref = useCallback((node: T | null) => {
    if (!node) {
      return () => undefined
    }

    // Measured now, during commit, so the first paint already clears the chrome.
    setHeight(node.offsetHeight)

    if (typeof ResizeObserver === 'undefined') {
      return () => setHeight(0)
    }

    const observer = new ResizeObserver(() => setHeight(node.offsetHeight))
    observer.observe(node)

    return () => {
      observer.disconnect()
      setHeight(0)
    }
  }, [])

  return [ref, height]
}
