/** The web build's preview: a sandboxed frame, never the daemon's origin. */
export function PreviewFrame({ uri }: { uri: string }) {
  return (
    <iframe
      key={uri}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
      src={uri}
      style={{ backgroundColor: '#ffffff', border: 0, flex: 1, height: '100%', width: '100%' }}
      title="Preview"
    />
  )
}
