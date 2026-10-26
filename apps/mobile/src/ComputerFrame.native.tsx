import { View } from 'react-native'
import { WebView } from 'react-native-webview'

/**
 * The bots' computer's screen: Cua's viewer, served by the daemon at
 * `/hexbot/computer/<token>/viewer/`. The link in its path is the credential,
 * so the frame keeps no cookies. It stays on that page; without `control` it
 * takes no touches and only shows the screen.
 */
export function ComputerFrame({ control, uri }: { control: boolean; uri: string }) {
  const base = uri.slice(0, uri.indexOf('/viewer/') + '/viewer/'.length)

  return (
    <View pointerEvents={control ? 'auto' : 'none'} style={{ flex: 1 }}>
      <WebView
        accessibilityLabel="Your bots' screen"
        allowFileAccess={false}
        allowsInlineMediaPlayback
        domStorageEnabled
        incognito
        javaScriptCanOpenWindowsAutomatically={false}
        key={uri}
        mediaPlaybackRequiresUserAction={false}
        onShouldStartLoadWithRequest={request => request.url.startsWith(base)}
        originWhitelist={[new URL(uri).origin]}
        scrollEnabled={false}
        sharedCookiesEnabled={false}
        source={{ uri }}
        style={{ backgroundColor: '#000000', flex: 1 }}
        testID="computer-frame"
        thirdPartyCookiesEnabled={false}
      />
    </View>
  )
}
