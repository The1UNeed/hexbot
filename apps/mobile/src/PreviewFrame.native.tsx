import { WebView } from 'react-native-webview'

/**
 * A page a bot serves on one of the user's computers, through the daemon at
 * `/hexbot/preview/<token>/`. The token is the credential, so the frame keeps
 * no cookies, and it stays inside that preview: links elsewhere don't load.
 */
export function PreviewFrame({ uri }: { uri: string }) {
  const marker = '/hexbot/preview/'
  const start = uri.indexOf(marker) + marker.length
  const base = uri.slice(0, uri.indexOf('/', start) + 1)

  return (
    <WebView
      accessibilityLabel="Preview"
      allowFileAccess={false}
      domStorageEnabled
      incognito
      javaScriptCanOpenWindowsAutomatically={false}
      key={uri}
      onShouldStartLoadWithRequest={request => request.url.startsWith(base)}
      originWhitelist={[new URL(uri).origin]}
      sharedCookiesEnabled={false}
      source={{ uri }}
      style={{ backgroundColor: '#ffffff', flex: 1 }}
      testID="preview-frame"
      thirdPartyCookiesEnabled={false}
    />
  )
}
