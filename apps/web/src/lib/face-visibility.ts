import { useEffect, useRef, useState } from 'react'

/** No frame loop: visibility changes are the only updates this hook schedules. */
export function useFaceVisibility<T extends Element>() {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    let onScreen = true
    const update = () => setVisible(onScreen && !document.hidden)

    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(entries => {
            onScreen = entries[0]?.isIntersecting ?? false
            update()
          })

    if (ref.current) {
      observer?.observe(ref.current)
    }

    document.addEventListener('visibilitychange', update)
    update()

    return () => {
      observer?.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  return { ref, visible }
}
