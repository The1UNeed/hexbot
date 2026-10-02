import { useState } from 'react'

import { cn } from '../../lib/cn'

/**
 * A title that can change under the user, like a section the bot renames.
 * The first text shows as is; each new text fades in once, so a rename reads
 * as a change rather than a flicker.
 */
export function Title({ className, text }: { className?: string; text: string }) {
  const [shown, setShown] = useState(text)
  const [renamed, setRenamed] = useState(false)

  if (text !== shown) {
    setShown(text)
    setRenamed(true)
  }

  return (
    <span className={cn(renamed && 'hex-fade', className)} key={text}>
      {text}
    </span>
  )
}
