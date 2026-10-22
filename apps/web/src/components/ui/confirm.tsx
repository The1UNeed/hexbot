import { type ReactNode, useEffect } from 'react'
import { create } from 'zustand'

import { Button } from './button'
import { Dialog } from './dialog'

export interface ConfirmRequest {
  /** One short line under the question: what Yes does. */
  detail?: ReactNode
  /** The question, ending in a question mark. */
  title: ReactNode
}

/**
 * The one yes-or-no prompt: a question, an optional line on what Yes does,
 * and No and Yes. No has focus first, so Enter never confirms by accident.
 */
export function ConfirmDialog({
  detail,
  onAnswer,
  open,
  title
}: ConfirmRequest & { onAnswer: (yes: boolean) => void; open: boolean }) {
  return (
    <Dialog
      alert
      className="w-[min(26rem,92vw)]"
      description={detail}
      onOpenChange={value => !value && onAnswer(false)}
      open={open}
      title={title}
    >
      <div className="space-y-4 px-6 pt-3 pb-5">
        <div className="flex justify-end gap-2">
          <Button onClick={() => onAnswer(false)} variant="ghost">
            No
          </Button>
          <Button onClick={() => onAnswer(true)} variant="primary">
            Yes
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

interface Pending extends ConfirmRequest {
  resolve: (yes: boolean) => void
}

// The question stays after the answer, so the closing window keeps its words.
const useConfirmStore = create<{ open: boolean; pending: null | Pending }>(() => ({
  open: false,
  pending: null
}))

/**
 * Asks a yes-or-no question in the app's own window, in place of
 * `window.confirm`. Resolves true for Yes. A second question answers the
 * first one No.
 */
export function confirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise(resolve => {
    const { open, pending } = useConfirmStore.getState()

    if (open) {
      pending?.resolve(false)
    }

    useConfirmStore.setState({ open: true, pending: { ...request, resolve } })
  })
}

/** Answers No when the page or daemon that asked the question changes. */
export function cancelConfirm(): void {
  const { open, pending } = useConfirmStore.getState()

  if (open) {
    useConfirmStore.setState({ open: false })
    pending?.resolve(false)
  }
}

/** Shows the question `confirm` asked. Mounted once, at the root. */
export function ConfirmHost({ blocked = false }: { blocked?: boolean }) {
  const { open, pending } = useConfirmStore()

  useEffect(() => {
    if (blocked && open) {
      cancelConfirm()
    }
  }, [blocked, open, pending])

  // Unmount the portal immediately: its focus trap escapes the app's inert wrapper.
  if (blocked) {
    return null
  }

  return (
    <ConfirmDialog
      detail={pending?.detail}
      onAnswer={yes => {
        if (useConfirmStore.getState().open && useConfirmStore.getState().pending === pending) {
          useConfirmStore.setState({ open: false })
          pending?.resolve(yes)
        }
      }}
      open={open}
      title={pending?.title}
    />
  )
}
