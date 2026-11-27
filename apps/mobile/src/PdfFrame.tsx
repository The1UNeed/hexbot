// Metro selects PdfFrame.native on iOS and Android. The web shows the blob in the browser's viewer.
export function PdfFrame({ title, uri }: { title: string; uri: string }) {
  return <iframe src={uri} style={{ border: 0, width: '100%', height: '100%', flex: 1 }} title={title} />
}
