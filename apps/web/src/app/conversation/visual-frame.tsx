import { ExternalLink, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { getBridge } from '../../lib/bridge'
import { useUi } from '../../stores/ui'

import {
  hostContext,
  readVisualTheme,
  type Visual,
  VISUAL_FRAME_SRC,
  VISUAL_MAX_HEIGHT,
  visualDocument,
  type VisualTheme
} from './visual'

/** The height a visual holds until its page reports its own. */
const FIRST_HEIGHT = 160

function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  query?.addEventListener('change', onChange)

  return () => query?.removeEventListener('change', onChange)
}

function systemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** The theme a visual sees; it changes when the user's theme or the system's mode does. */
function useVisualTheme(): VisualTheme {
  const choice = useUi(state => state.theme)
  const dark = useSyncExternalStore(subscribeToSystemTheme, systemDark)

  // The store applies a theme to the document before its subscribers render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readVisualTheme(), [choice, dark])
}

/** An http(s) URL the page asked to open, or null for anything else. */
function linkUrl(href: unknown): null | URL {
  try {
    const url = new URL(String(href))

    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function openLink(url: URL) {
  const bridge = getBridge()

  if (bridge) {
    void bridge.openExternal(url.href)
  } else {
    window.open(url.href, '_blank', 'noopener,noreferrer')
  }
}

/**
 * One visual a bot showed: its page in a frame sandboxed without
 * allow-same-origin, sized to the page's height and themed like the app.
 */
export function VisualFrame({ visual }: { visual: Visual }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(FIRST_HEIGHT)
  const [link, setLink] = useState<null | URL>(null)
  const theme = useVisualTheme()
  const current = useRef(theme)

  useEffect(() => {
    current.current = theme
    frame.current?.contentWindow?.postMessage(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: hostContext(theme)
      },
      '*'
    )
  }, [theme])

  // A layout effect listens before the frame can load and say it is ready;
  // a passive one could run after that message and leave the frame blank.
  useLayoutEffect(() => {
    function onMessage(event: MessageEvent) {
      const target = frame.current?.contentWindow

      const data = event.data as {
        id?: unknown
        method?: unknown
        params?: Record<string, unknown>
      }

      if (!target || event.source !== target || !data || typeof data !== 'object') {
        return
      }

      if (data.method === 'hexbot/visual/ready') {
        target.postMessage(
          {
            jsonrpc: '2.0',
            method: 'hexbot/visual/show',
            params: { document: visualDocument(visual.html, current.current) }
          },
          '*'
        )
      } else if (data.method === 'ui/notifications/size-changed') {
        const next = Number(data.params?.height)

        // A page of only positioned content measures 0; keep the frame open.
        if (Number.isFinite(next) && next > 0) {
          setHeight(Math.min(Math.ceil(next), VISUAL_MAX_HEIGHT))
        }
      } else if (data.method === 'ui/open-link') {
        // The page cannot prove the user clicked it, so it only offers the
        // link; opening takes a click on the app's own button below.
        setLink(linkUrl(data.params?.url))
        target.postMessage({ id: data.id, jsonrpc: '2.0', result: {} }, '*')
      }
    }

    window.addEventListener('message', onMessage)

    return () => window.removeEventListener('message', onMessage)
  }, [visual.html])

  return (
    <div className="flex w-full flex-col items-start gap-1">
      <iframe
        className="block w-full border-0 bg-transparent"
        data-testid="visual"
        ref={frame}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src={VISUAL_FRAME_SRC}
        style={{ colorScheme: theme.appearance, height }}
        title={visual.title}
      />
      {link ? (
        <div className="flex max-w-full items-center gap-1 text-[length:var(--text-meta)]">
          <button
            className="hex-focus flex min-w-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted hover:text-foreground"
            onClick={() => {
              openLink(link)
              setLink(null)
            }}
            type="button"
          >
            <span className="truncate">Open {link.host + link.pathname.replace(/\/$/, '')}</span>
            <ExternalLink className="shrink-0" size={11} />
          </button>
          <button
            aria-label="Dismiss"
            className="hex-focus rounded-full p-1 text-muted hover:text-foreground"
            onClick={() => setLink(null)}
            type="button"
          >
            <X size={11} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** The visuals of one bot message, each the full width of the column. */
export function Visuals({ visuals }: { visuals: Visual[] }) {
  if (!visuals.length) {
    return null
  }

  return (
    <div className="flex w-full flex-col gap-3 py-1">
      {visuals.map(visual => (
        <VisualFrame key={visual.toolId} visual={visual} />
      ))}
    </div>
  )
}
