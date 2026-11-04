import { type ReactNode, useEffect, useState } from 'react'

import { filesRead } from '../../lib/api'
import type { AttachmentKind } from '../../lib/types'

import { blobFromDataUrl } from './file-tab'

/**
 * Where a file plays from: this page's own copy, or the daemon's, read once
 * through the chat's session and held as an object URL while it shows. The
 * app's policy plays media only from the page or a blob, never a data URL.
 */
function useMediaUrl(
  url: string | undefined,
  path: string | undefined,
  sessionId: string | undefined
): { failed: boolean; src: string | undefined } {
  const [read, setRead] = useState<{ failed: boolean; src: string | undefined }>({
    failed: false,
    src: undefined
  })

  useEffect(() => {
    if (url || !path || !sessionId) {
      return
    }

    let live = true
    let made: string | undefined

    filesRead(sessionId, path)
      .then(file => {
        const blob = file.data_url ? blobFromDataUrl(file.data_url) : null

        if (!blob) {
          throw new Error('not a media file')
        }

        made = URL.createObjectURL(blob)

        if (live) {
          setRead({ failed: false, src: made })
        } else {
          URL.revokeObjectURL(made)
        }
      })
      .catch(() => live && setRead({ failed: true, src: undefined }))

    return () => {
      live = false

      if (made) {
        URL.revokeObjectURL(made)
      }
    }
  }, [path, sessionId, url])

  return url ? { failed: false, src: url } : read
}

/**
 * A picture, video or audio file in the chat. A picture opens over the chat;
 * a video or audio file plays where it is. While the daemon's copy loads the
 * space it will take is held; a file that cannot be read is its card.
 */
export function MediaView({
  fallback,
  kind,
  name,
  onImage,
  path,
  sessionId,
  url
}: {
  fallback: ReactNode
  kind: AttachmentKind
  name: string
  onImage: (source: string) => void
  path?: string
  sessionId?: string
  url?: string
}) {
  const { failed, src } = useMediaUrl(url, path, sessionId)

  if (failed) {
    return fallback
  }

  if (!src) {
    return (
      <div
        aria-busy
        aria-label={`Loading ${name}`}
        className={
          kind === 'audio'
            ? 'h-[54px] w-72 max-w-full rounded-full bg-foreground/[0.06]'
            : 'aspect-video w-72 max-w-full rounded-panel bg-foreground/[0.06]'
        }
        role="img"
      />
    )
  }

  if (kind === 'image') {
    return (
      <button
        aria-label={`Open ${name}`}
        className="hex-focus rounded-panel"
        onClick={() => onImage(src)}
        type="button"
      >
        <img alt={name} className="max-h-64 rounded-panel object-contain" src={src} />
      </button>
    )
  }

  if (kind === 'audio') {
    return (
      <audio aria-label={name} className="w-72 max-w-full" controls preload="metadata" src={src} />
    )
  }

  return (
    <video
      aria-label={name}
      className="max-h-64 max-w-full rounded-panel bg-black"
      controls
      playsInline
      preload="metadata"
      src={src}
    />
  )
}
