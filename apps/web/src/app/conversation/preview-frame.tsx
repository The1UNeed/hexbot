/**
 * A page a bot serves on one of the user's computers, beside the chat. The
 * daemon forwards it (`/hexbot/preview/<token>/…`) and marks it sandboxed;
 * the frame is sandboxed too, so the page never runs as Hexbot.
 */

import { ExternalLink, RotateCw } from 'lucide-react'
import { useState } from 'react'

import { getBridge } from '../../lib/bridge'
import { targetOrigin } from '../../lib/connection'
import { useConnection } from '../../stores/connection'
import type { PreviewTab } from '../../stores/visuals'

export function PreviewFrame({ tab }: { tab: PreviewTab }) {
  const target = useConnection(state => state.target)
  const [reloads, setReloads] = useState(0)

  if (!target) {
    return null
  }

  const url = `${targetOrigin(target)}${tab.preview.path}`

  const open = () => {
    const bridge = getBridge()

    if (bridge) {
      void bridge.openExternal(url)
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-9 items-center gap-1 px-3 text-[length:var(--text-meta)] text-muted">
        <span className="min-w-0 flex-1 truncate" data-testid="preview-computer">
          On {tab.preview.computer}
        </span>
        <button
          aria-label="Reload"
          className="hex-focus grid size-7 place-items-center rounded-full hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={() => setReloads(count => count + 1)}
          type="button"
        >
          <RotateCw size={13} />
        </button>
        <button
          aria-label="Open in browser"
          className="hex-focus grid size-7 place-items-center rounded-full hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={open}
          type="button"
        >
          <ExternalLink size={13} />
        </button>
      </div>
      <iframe
        className="min-h-0 w-full flex-1 border-0 bg-white"
        data-testid="preview"
        key={reloads}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        src={url}
        title={tab.title}
      />
    </div>
  )
}
