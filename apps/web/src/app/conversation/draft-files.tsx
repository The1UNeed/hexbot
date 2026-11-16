import { RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  attachFile,
  attachmentKind,
  attachmentRemove,
  type AttachResult,
  forgetWholeOnly,
  WholeFilesOnly
} from '../../lib/api'
import { cn } from '../../lib/cn'
import { mediaKind } from '../../lib/media'
import type { AttachmentKind } from '../../lib/types'
import { useConnection } from '../../stores/connection'

import { FileCard } from './file-card'
import { mimeOf } from './shared-files'

/** Where a file in the composer is on its way to the daemon. */
export type DraftUpload =
  | { state: 'waiting' }
  /** `progress` is the share the daemon has, 0 to 1. */
  | { epoch: null | string; progress: number; session: string; state: 'uploading' }
  | { epoch: null | string; result: AttachResult & { id: string }; session: string; state: 'ready' }
  /**
   * Kept here for a daemon from before part uploads, which could not take
   * it back: it goes with Send, as before.
   */
  | { state: 'kept' }
  | { error: string; state: 'failed' }

/** A file in the composer. */
export interface DraftAttachment {
  file: File
  id: string
  /** This page's copy of a picture, for its thumbnail and to open it. */
  preview?: string
  upload: DraftUpload
}

let drafted = 0

function draftOf(file: File): DraftAttachment {
  return {
    file,
    id: `${file.name}-${file.size}-${++drafted}`,
    preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    upload: { state: 'waiting' }
  }
}

/**
 * How a sent file shows in its message: the same reading the upload used, so
 * a .pdf with no type is a PDF; a video or audio file with no type is known
 * by its name.
 */
export function sentKind(file: File): AttachmentKind {
  const sent = attachmentKind(file.type, file.name)
  const media = mediaKind(file.type || mimeOf(file.name), file.name)

  return sent === 'file' && (media === 'video' || media === 'audio') ? media : sent
}

/** Ready for Send: staged in the chat's live session in this daemon process, or kept here. */
function sendable(upload: DraftUpload, session: null | string, epoch: null | string): boolean {
  return (
    upload.state === 'kept' ||
    (upload.state === 'ready' && upload.session === session && upload.epoch === epoch)
  )
}

/** Takes an upload back, unless the daemon process that held it is gone. */
function release(upload: DraftUpload, epoch: null | string) {
  if (upload.state === 'ready' && upload.epoch === epoch) {
    void attachmentRemove(upload.session, upload.result.id)
  }
}

/**
 * The composer's files. Each one is uploaded the moment it arrives, one at a
 * time, and staged in the chat's live session, so Send only names what the
 * daemon already holds. A file staged in another session or daemon process,
 * after a restart or a reopen, goes again; one taken out is taken back.
 */
export function useDraftFiles(sessionId: null | string) {
  const epoch = useConnection(state => state.epoch)
  const [files, setFiles] = useState<DraftAttachment[]>([])
  // An upload that ends with nothing changed still lets the next one start.
  const [settled, setSettled] = useState(0)
  const latest = useRef(files)
  latest.current = files
  // One upload at a time; `going` names the one whose answer still counts.
  // A ref, not the rendered state: a quick answer can land before the render.
  const running = useRef(false)
  const going = useRef<null | { id: string; stop: AbortController }>(null)
  const alive = useRef(true)

  // A file taken out while it is still read here is never sent.
  const forget = (id?: string) => {
    if (!id || going.current?.id === id) {
      going.current?.stop.abort()
      going.current = null
    }
  }

  const patch = useCallback((id: string, upload: DraftUpload) => {
    setFiles(current => current.map(item => (item.id === id ? { ...item, upload } : item)))
  }, [])

  useEffect(() => {
    // While the chat is checked again it has no session for a moment; its
    // uploads stay, unless the daemon process that held them is gone.
    const moved = files.filter(
      item =>
        (item.upload.state === 'uploading' || item.upload.state === 'ready') &&
        (item.upload.epoch !== epoch || (sessionId !== null && item.upload.session !== sessionId))
    )

    if (moved.length) {
      for (const item of moved) {
        forget(item.id)
        release(item.upload, epoch)
      }

      setFiles(current =>
        current.map(item =>
          moved.includes(item) ? { ...item, upload: { state: 'waiting' } } : item
        )
      )

      return
    }

    const next = files.find(item => item.upload.state === 'waiting')

    if (!sessionId || running.current || !next) {
      return
    }

    running.current = true
    const at = { epoch, session: sessionId }
    const token = { id: next.id, stop: new AbortController() }
    going.current = token
    // Still in the composer, and still going to the session it started for.
    const current = () => alive.current && going.current === token

    patch(next.id, { ...at, progress: 0, state: 'uploading' })

    attachFile(sessionId, next.file, {
      ahead: true,
      onProgress: progress => {
        if (current()) {
          patch(next.id, { ...at, progress, state: 'uploading' })
        }
      },
      signal: token.stop.signal
    })
      .then(result => {
        const id = result.id

        if (typeof id !== 'string') {
          throw new Error('The daemon did not return an attachment ID. Attach the file again.')
        }

        if (current()) {
          going.current = null
          patch(next.id, { ...at, result: { ...result, id }, state: 'ready' })
        } else {
          // Taken out, or the chat moved on, while it went.
          release(
            { ...at, result: { ...result, id }, state: 'ready' },
            useConnection.getState().epoch
          )
        }
      })
      .catch((error: unknown) => {
        if (current() && error instanceof WholeFilesOnly) {
          going.current = null
          patch(next.id, { state: 'kept' })
        } else if (current()) {
          going.current = null
          patch(next.id, {
            error: error instanceof Error ? error.message : String(error),
            state: 'failed'
          })
        }
      })
      .finally(() => {
        running.current = false

        if (alive.current) {
          setSettled(count => count + 1)
        }
      })
  }, [epoch, files, patch, sessionId, settled])

  // A new daemon process, as after an update, may take parts.
  useEffect(() => forgetWholeOnly(), [epoch])

  // Leaving the chat takes back what it staged and never sent.
  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
      forget()

      for (const item of latest.current) {
        release(item.upload, useConnection.getState().epoch)
      }
    }
  }, [])

  return {
    add: (incoming: File[]) => setFiles(current => [...current, ...incoming.map(draftOf)]),
    files,
    /** Every file is staged where Send will name it. */
    ready: files.every(item => sendable(item.upload, sessionId, epoch)),
    remove: (id: string) => {
      const item = latest.current.find(file => file.id === id)

      forget(id)

      if (item) {
        release(item.upload, epoch)
      }

      setFiles(current => current.filter(file => file.id !== id))
    },
    /** Files a message took that come back to edit: their uploads are gone, so they go again. */
    restore: (items: DraftAttachment[]) => {
      forget()

      for (const item of items) {
        release(item.upload, epoch)
      }

      setFiles(items.map(item => ({ ...item, upload: { state: 'waiting' } })))
    },
    retry: (id: string) => patch(id, { state: 'waiting' }),
    /** Empties the composer for a message that now holds these files and their uploads. */
    take: () => {
      forget()
      latest.current = []
      setFiles([])
    }
  }
}

/** `0.42` as "42%". */
const percent = (value: number) => `${Math.floor(value * 100)}%`

/** The words under a file while it is not ready to send yet. */
function uploadLine(upload: DraftUpload) {
  switch (upload.state) {
    case 'waiting':
      return 'Waiting to upload'

    case 'uploading':
      return <span className="tabular-nums">Uploading {percent(upload.progress)}</span>

    case 'failed':
      // Why, such as a file over the size limit; clicking the card tries again.
      return <span className="text-danger">Not uploaded: {upload.error}</span>

    default:
      return undefined
  }
}

/**
 * The files above the composer's field. Each shows how much of it the
 * daemon has; one that is up, or kept here for an older daemon, opens to
 * preview, and one that failed tries again when clicked.
 */
export function DraftFiles({
  files,
  onOpen,
  onRemove,
  onRetry
}: {
  files: DraftAttachment[]
  onOpen: (item: DraftAttachment) => void
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-2" data-testid="draft-files">
      {files.map(item => {
        const { file, upload } = item
        const going = upload.state === 'waiting' || upload.state === 'uploading'
        const done = upload.state === 'ready' || upload.state === 'kept'
        const progress = upload.state === 'uploading' ? upload.progress : 0
        // A file kept here for an older daemon is not on the daemon yet: only
        // what this page can show by itself previews.
        const previews = upload.state === 'ready' || sentKind(file) !== 'file'

        const action = done
          ? previews
            ? { label: `Preview ${file.name}`, run: () => onOpen(item) }
            : undefined
          : upload.state === 'failed'
            ? { label: `Retry uploading ${file.name}`, run: () => onRetry(item.id) }
            : undefined

        const meter = going ? (
          <span
            aria-label={`Uploading ${file.name}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.floor(progress * 100)}
            className="sr-only"
            role="progressbar"
          />
        ) : null

        if (item.preview) {
          const picture = (
            <>
              <img
                alt={file.name}
                className="size-14 rounded-[14px] object-cover shadow-card"
                src={item.preview}
              />
              {!done ? (
                <span
                  aria-hidden
                  className={cn(
                    'absolute inset-0 grid place-items-center rounded-[14px] text-white',
                    upload.state === 'failed' ? 'bg-black/55' : 'bg-black/40'
                  )}
                >
                  {upload.state === 'failed' ? (
                    <RotateCw size={16} strokeWidth={2.5} />
                  ) : (
                    <span className="text-[length:var(--text-meta)] font-semibold tabular-nums">
                      {percent(progress)}
                    </span>
                  )}
                </span>
              ) : null}
            </>
          )

          return (
            <div
              className="relative"
              key={item.id}
              title={upload.state === 'failed' ? upload.error : file.name}
            >
              {action ? (
                <button
                  aria-label={action.label}
                  className="hex-focus relative block rounded-[14px]"
                  onClick={action.run}
                  type="button"
                >
                  {picture}
                </button>
              ) : (
                <div className="relative">{picture}</div>
              )}
              {meter}
              <button
                aria-label={`Remove ${file.name}`}
                className="hex-focus absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background shadow-card"
                onClick={() => onRemove(item.id)}
                type="button"
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            </div>
          )
        }

        return (
          <div className="relative w-[min(100%,17.5rem)]" key={item.id}>
            <FileCard
              detail={uploadLine(upload)}
              label={action?.label}
              name={file.name}
              onOpen={action?.run}
              onRemove={() => onRemove(item.id)}
              size={done ? file.size : undefined}
            />
            {upload.state === 'uploading' ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-4 bottom-1.5 h-[3px] overflow-hidden rounded-full bg-foreground/[0.08]"
              >
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: percent(progress) }}
                />
              </span>
            ) : null}
            {meter}
          </div>
        )
      })}
    </div>
  )
}
