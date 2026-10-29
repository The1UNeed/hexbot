import { useEffect, useRef } from 'react'

// Metro selects ComputerFrame.native on iOS and Android; the browser preview uses a frame.
export function ComputerFrame({
  control,
  onStatus,
  uri
}: {
  control: boolean
  /** The screen's state as its page reports it: `streaming` once the picture is up. */
  onStatus?: (status: string) => void
  uri: string
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const report = useRef(onStatus)
  report.current = onStatus

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const message = (event.data as { status?: string; type?: string } | null) ?? {}
      if (
        event.source === frame.current?.contentWindow &&
        message.type === 'hexbot.computer.screen' &&
        message.status
      )
        report.current?.(message.status)
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [])

  return (
    <iframe
      allow="clipboard-read; clipboard-write; fullscreen; autoplay"
      key={uri}
      ref={frame}
      referrerPolicy="no-referrer"
      src={uri}
      style={{
        backgroundColor: '#000000',
        border: 0,
        flex: 1,
        height: '100%',
        pointerEvents: control ? 'auto' : 'none',
        width: '100%'
      }}
      tabIndex={control ? 0 : -1}
      title="Your bots' screen"
    />
  )
}
