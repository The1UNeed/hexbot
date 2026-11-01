import { CircleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Spinner } from '../../components/ui/spinner'
import { cn } from '../../lib/cn'

/** How long a message may wait for the daemon before its bubble offers Retry. */
export const SEND_TIMEOUT_MS = 15_000

/** True once `SEND_TIMEOUT_MS` has passed since `since`; false while unset. */
export function useLate(since: number | undefined): boolean {
  // Remembers which attempt ran late, so a new attempt starts on time and a
  // row with nothing in flight never renders again for it.
  const [lateFor, setLateFor] = useState<number>()

  useEffect(() => {
    if (since === undefined) {
      return
    }

    const timer = setTimeout(
      () => setLateFor(since),
      Math.max(0, since + SEND_TIMEOUT_MS - Date.now())
    )

    return () => clearTimeout(timer)
  }, [since])

  return since !== undefined && lateFor === since
}

/**
 * The mark's box matches the bubble's hover actions and sits on the bubble's
 * last line, so a one-line bubble, its mark, and Copy share one centre.
 */
const markBox = 'grid size-7 shrink-0 place-items-center self-end mb-1.5 rounded-full'

/**
 * Beside your bubble while it is not sent: a spinner while it goes, a red
 * mark once it failed, which retries when it can.
 */
export function DeliveryMark({
  delivery,
  onRetry
}: {
  delivery: 'failed' | 'sending'
  onRetry?: () => void
}) {
  if (delivery === 'sending') {
    return (
      <span className={cn(markBox, 'hex-pending-mark')}>
        <Spinner className="text-muted" label="Sending" size="sm" />
      </span>
    )
  }

  return onRetry ? (
    <button
      aria-label="Retry sending"
      className={cn(
        markBox,
        'hex-focus hex-fade cursor-pointer text-danger transition-colors duration-[var(--hex-motion-fast)] hover:bg-danger/10'
      )}
      onClick={onRetry}
      title="Retry"
      type="button"
    >
      <CircleAlert size={17} />
    </button>
  ) : (
    <span className={cn(markBox, 'hex-fade text-danger')}>
      <CircleAlert aria-hidden size={17} />
    </span>
  )
}

/**
 * The line under a bubble that did not send: what is known, why on hover, and
 * Retry when it can.
 */
export function NotSent({
  label,
  onRetry,
  reason
}: {
  label: string
  onRetry?: () => void
  reason?: string
}) {
  return (
    <p
      className="hex-fade flex items-center gap-1.5 px-1 text-[length:var(--text-meta)] text-danger"
      role="alert"
      title={reason}
    >
      {label}
      {onRetry ? (
        <>
          <span aria-hidden>·</span>
          <button
            className="hex-focus rounded font-medium underline-offset-2 hover:underline"
            onClick={onRetry}
            type="button"
          >
            Retry
          </button>
        </>
      ) : null}
    </p>
  )
}
