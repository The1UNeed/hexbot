import { View } from 'react-native'
import { WebView } from 'react-native-webview'

/**
 * The bots' computer's screen: Cua's viewer, served by the daemon at
 * `/hexbot/computer/<token>/viewer/`. The link in its path is the credential,
 * so the frame keeps no cookies. It stays on that page; without `control` it
 * takes no touches and only shows the screen.
 */
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
        onMessage={event => {
          try {
            const message = JSON.parse(event.nativeEvent.data) as { status?: string; type?: string }
            if (message.type === 'hexbot.computer.screen' && message.status) onStatus?.(message.status)
          } catch {
            // Only the daemon's screen script posts here.
          }
        }}
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
