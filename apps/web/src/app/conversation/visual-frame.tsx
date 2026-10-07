import { ChartColumn, ChevronsRight, ExternalLink, Maximize2, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'

import { getBridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { useUi } from '../../stores/ui'
import { useVisuals, visualsActions } from '../../stores/visuals'

import {
  hostContext,
  readVisualTheme,
  type Visual,
  VISUAL_FRAME_SRC,
  VISUAL_MAX_HEIGHT,
  visualDocument,
  type VisualTheme
} from './visual'

/** The height a visual's frame keeps, invisible, until its page reports its own. */
const FIRST_HEIGHT = 120

function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  query?.addEventListener('change', onChange)

  return () => query?.removeEventListener('change', onChange)
}

function systemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/**
 * The theme a visual sees; it changes when the user's theme or the system's
 * mode does. `surface` names the app token the page sits on, so a page drawn
 * inside a bubble or a card has that background.
 */
function useVisualTheme(surface: string): VisualTheme {
  const choice = useUi(state => state.theme)
  const dark = useSyncExternalStore(subscribeToSystemTheme, systemDark)

  // The store applies a theme to the document before its subscribers render.
  return useMemo(() => {
    const theme = readVisualTheme()
    const value = getComputedStyle(document.documentElement).getPropertyValue(surface).trim()

    return value ? { ...theme, variables: { ...theme.variables, '--background': value } } : theme
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, dark, surface])
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
 * A visual's page in a frame sandboxed without allow-same-origin, themed like
 * the app. The frame stays invisible until the page reports its height, then
 * fades in at that height, so nothing jumps into place.
 */
export function VisualPage({
  onLink,
  surface = '--hex-background',
  visual
}: {
  onLink: (url: URL) => void
  surface?: string
  visual: Visual
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState<number>()
  const theme = useVisualTheme(surface)
  const current = useRef(theme)
  const link = useRef(onLink)

  useEffect(() => {
    link.current = onLink
  }, [onLink])

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

        // A hidden tab, or a page of only positioned content, measures 0.
        if (Number.isFinite(next) && next > 0) {
          setHeight(Math.min(Math.ceil(next), VISUAL_MAX_HEIGHT))
        }
      } else if (data.method === 'ui/open-link') {
        // The page cannot prove the user clicked it, so it only offers the
        // link; opening takes a click on the app's own button.
        const url = linkUrl(data.params?.url)

        if (url) {
          link.current(url)
        }

        target.postMessage({ id: data.id, jsonrpc: '2.0', result: {} }, '*')
      }
    }

    window.addEventListener('message', onMessage)

    return () => window.removeEventListener('message', onMessage)
  }, [visual.html])

  return (
    <iframe
      className={cn(
        'block w-full border-0 bg-transparent transition-[opacity,height] duration-[var(--hex-motion-panel)] ease-[var(--hex-ease-out)]',
        height === undefined ? 'opacity-0' : 'opacity-100'
      )}
      data-testid="visual"
      ref={frame}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={VISUAL_FRAME_SRC}
      style={{ colorScheme: theme.appearance, height: height ?? FIRST_HEIGHT }}
      title={visual.title}
    />
  )
}

/** A link the page asked to open, waiting for the user's click. */
function useLinkOffer() {
  const [link, setLink] = useState<null | URL>(null)

  const offer = link ? (
    <div className="hex-pop flex max-w-full items-center gap-1 text-[length:var(--text-meta)]">
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
  ) : null

  return { offer, setLink }
}

const actionClass =
  'hex-focus grid size-7 place-items-center rounded-full text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground'

function Action({
  children,
  label,
  onClick,
  pressed
}: {
  children: ReactNode
  label: string
  onClick: () => void
  pressed?: boolean
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={cn(actionClass, pressed && 'bg-foreground/[0.06] text-foreground')}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

/**
 * One visual in the chat: a bot bubble with the page inside, live to hover
 * and click, under a title row whose one action, Expand, opens it beside the
 * chat as a tab.
 */
export function VisualBubble({ fresh = false, visual }: { fresh?: boolean; visual: Visual }) {
  const beside = useVisuals(state => state.tabs.some(tab => tab.toolId === visual.toolId))
  const { offer, setLink } = useLinkOffer()

  return (
    <div className="flex w-full flex-col items-start gap-1">
      <div
        className={cn('w-full rounded-[20px] bg-bubble pb-3.5', fresh && 'hex-message')}
        data-testid="visual-bubble"
      >
        <div className="flex h-11 items-center gap-2 pr-2 pl-4">
          <ChartColumn className="shrink-0 text-muted" size={14} />
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-secondary)] font-medium">
            {visual.title}
          </span>
          <Action
            label="Expand beside the chat"
            onClick={() => visualsActions().open(visual)}
            pressed={beside}
          >
            <Maximize2 size={14} />
          </Action>
        </div>
        <div className="px-4">
          <VisualPage onLink={setLink} surface="--hex-bubble" visual={visual} />
        </div>
      </div>
      {offer}
    </div>
  )
}

/** The visuals of one bot message, each its own bubble. */
export function Visuals({ fresh, visuals }: { fresh?: boolean; visuals: Visual[] }) {
  if (!visuals.length) {
    return null
  }

  return (
    <div className="flex w-full flex-col gap-1">
      {visuals.map(visual => (
        <VisualBubble fresh={fresh} key={visual.toolId} visual={visual} />
      ))}
    </div>
  )
}

/** One open tab's page; every tab stays mounted so switching keeps its state. */
function VisualTab({ shown, visual }: { shown: boolean; visual: Visual }) {
  const { offer, setLink } = useLinkOffer()

  return (
    <div
      aria-labelledby={`visual-tab-${visual.toolId}`}
      className="flex flex-col gap-2"
      hidden={!shown}
      id={`visual-tabpanel-${visual.toolId}`}
      role="tabpanel"
    >
      <div className="rounded-[16px] bg-background p-4 shadow-card">
        <VisualPage onLink={setLink} visual={visual} />
      </div>
      {offer}
    </div>
  )
}

/**
 * The side panel's view of the visuals opened beside the chat: one tab each,
 * like a browser's. Closing the last tab, or the panel, closes them all.
 */
export function VisualPanel() {
  const tabs = useVisuals(state => state.tabs)
  const active = useVisuals(state => state.active)

  const step = (event: KeyboardEvent) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key]

    if (!offset) {
      return
    }

    event.preventDefault()
    const index = tabs.findIndex(tab => tab.toolId === active)
    const next = tabs[(index + offset + tabs.length) % tabs.length]

    if (next) {
      visualsActions().activate(next.toolId)
      document.getElementById(`visual-tab-${next.toolId}`)?.focus()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <div
          aria-label="Visuals"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          onKeyDown={step}
          role="tablist"
        >
          {tabs.map(tab => {
            const shown = tab.toolId === active

            return (
              <div
                className={cn(
                  'flex h-8 max-w-[13rem] shrink-0 items-center rounded-full transition-colors duration-[var(--hex-motion-fast)]',
                  shown
                    ? 'bg-background text-foreground shadow-card'
                    : 'text-muted hover:bg-foreground/[0.05] hover:text-foreground'
                )}
                key={tab.toolId}
              >
                <button
                  aria-controls={`visual-tabpanel-${tab.toolId}`}
                  aria-selected={shown}
                  className="hex-focus flex h-full min-w-0 items-center gap-1.5 rounded-full pr-1 pl-3 text-[length:var(--text-secondary)] font-medium"
                  id={`visual-tab-${tab.toolId}`}
                  onClick={() => visualsActions().activate(tab.toolId)}
                  role="tab"
                  tabIndex={shown ? 0 : -1}
                  type="button"
                >
                  <ChartColumn className="shrink-0" size={13} />
                  <span className="truncate">{tab.title}</span>
                </button>
                <button
                  aria-label={`Close ${tab.title}`}
                  className="hex-focus mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-foreground/[0.08] hover:text-foreground"
                  onClick={() => visualsActions().close(tab.toolId)}
                  type="button"
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <Action label="Close visuals" onClick={() => visualsActions().closeAll()}>
          <ChevronsRight size={16} />
        </Action>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {tabs.map(tab => (
          <VisualTab key={tab.toolId} shown={tab.toolId === active} visual={tab} />
        ))}
      </div>
    </div>
  )
}
