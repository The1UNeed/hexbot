// Metro selects ComputerFrame.native on iOS and Android; the browser preview uses a frame.
export function ComputerFrame({ control, uri }: { control: boolean; uri: string }) {
  return (
    <iframe
      allow="clipboard-read; clipboard-write; fullscreen; autoplay"
      key={uri}
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
