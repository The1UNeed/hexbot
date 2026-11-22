import { Download } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { filesRead } from '../../lib/api'
import type { AttachmentKind } from '../../lib/types'
import { useConnection } from '../../stores/connection'

import { blobFromDataUrl } from './file-tab'

/**
 * Use the daemon's HTTP stream for remote media. Older daemons return bytes
 * inline, which the player can open through a temporary blob URL.
 */
function useMediaUrl(
  url: string | undefined,
  path: string | undefined,
  sessionId: string | undefined,
  attempt: number
): { failed: boolean; src: string | undefined } {
  const connects = useConnection(state => state.connects)

  const [read, setRead] = useState<{ attempt: number; failed: boolean; src: string | undefined }>({
    attempt,
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
        if (file.mediaUrl) {
          if (live) {
            setRead({ attempt, failed: false, src: file.mediaUrl })
          }

          return
        }

        const blob = file.data_url ? blobFromDataUrl(file.data_url) : null

        if (!blob) {
          throw new Error('not a media file')
        }

        made = URL.createObjectURL(blob)

        if (live) {
          setRead({ attempt, failed: false, src: made })
        } else {
          URL.revokeObjectURL(made)
        }
      })
      .catch(() => live && setRead({ attempt, failed: true, src: undefined }))

    return () => {
      live = false

      if (made) {
        URL.revokeObjectURL(made)
      }
    }
  }, [attempt, connects, path, sessionId, url])

  return url || read.attempt !== attempt ? { failed: false, src: url } : read
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
  const [attempt, setAttempt] = useState(0)
  const [broken, setBroken] = useState<string>()
  const deferred = !url && kind !== 'image'

  const { failed, src } = useMediaUrl(
    url,
    deferred && !attempt ? undefined : path,
    sessionId,
    attempt
  )

  const retry = Boolean(path && !url && (failed || (src && broken === src)))
  const onError = path && !url ? () => setBroken(src) : undefined

  if (retry || (deferred && !src && !failed)) {
    const busy = attempt > 0 && !retry
    const label = retry ? `Reload ${name}` : name

    return (
      <Button
        aria-label={retry ? label : `${busy ? 'Loading' : 'Load'} ${name}`}
        busy={busy}
        className="max-w-full"
        icon={<Download size={16} />}
        onClick={() => {
          setBroken(undefined)
          setAttempt(value => value + 1)
        }}
        variant="pill"
      >
        <span className="truncate">{label}</span>
      </Button>
    )
  }

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
        <img
          alt={name}
          className="max-h-64 rounded-panel object-contain"
          onError={onError}
          src={src}
        />
      </button>
    )
  }

  if (kind === 'audio') {
    return (
      <audio
        aria-label={name}
        className="w-72 max-w-full"
        controls
        onError={onError}
        preload="metadata"
        src={src}
      />
    )
  }

  return (
    <video
      aria-label={name}
      className="max-h-64 max-w-full rounded-panel bg-black"
      controls
      onError={onError}
      playsInline
      preload="metadata"
      src={src}
    />
  )
}
