import { WebView } from 'react-native-webview'

/**
 * A PDF the phone keeps a copy of, in the system's own viewer. iOS draws PDFs
 * in a WebView; Android's cannot, so the sheet offers no PDF preview there.
 * The view reads only the copy's folder and opens nothing else.
 */
export function PdfFrame({ title, uri }: { title: string; uri: string }) {
  return (
    <WebView
      accessibilityLabel={title}
      allowingReadAccessToURL={uri.slice(0, uri.lastIndexOf('/') + 1)}
      allowFileAccess
      incognito
      javaScriptEnabled={false}
      onShouldStartLoadWithRequest={r => r.url === uri}
      originWhitelist={['file://*']}
      source={{ uri }}
      style={{ flex: 1 }}
      testID="file-pdf"
    />
  )
}
