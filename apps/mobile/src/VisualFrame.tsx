// Metro selects VisualFrame.native on iOS and Android. Web uses an opaque sandbox.
export function VisualFrame({
  background,
  document,
  title
}: {
  background?: string
  document: string
  title: string
}) {
  return (
    <iframe
      title={title}
      srcDoc={document}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ border: 0, width: '100%', height: '100%', flex: 1, background }}
    />
  )
}
