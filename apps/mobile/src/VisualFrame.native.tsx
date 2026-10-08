import { Alert, Linking } from 'react-native'
import { WebView } from 'react-native-webview'
export function VisualFrame({ document, title }: { document: string; title: string }) {
  const open = (href: string) => {
    if (!/^https?:\/\//i.test(href)) return
    Alert.alert('Open link', href, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open',
        onPress: () => {
          void Linking.openURL(href)
        }
      }
    ])
  }
  return (
    <WebView
      accessibilityLabel={title}
      source={{ html: document }}
      originWhitelist={['*']}
      incognito
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      domStorageEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows
      onOpenWindow={e => open(e.nativeEvent.targetUrl)}
      onShouldStartLoadWithRequest={r => {
        if (r.url === 'about:blank') return true
        open(r.url)
        return false
      }}
      style={{ flex: 1 }}
      testID="visual-frame"
    />
  )
}
