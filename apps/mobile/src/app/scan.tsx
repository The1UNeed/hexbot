import { CameraView, useCameraPermissions } from 'expo-camera'
import { router } from 'expo-router'
import { useRef } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Button } from '../components/button'
import { GlassButton } from '../components/glass'
import { parsePairLink } from '../lib/pair-link'

/** Scan the pairing QR that `hexbot pair` and Settings, Network show. */
export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions()
  const insets = useSafeAreaInsets()
  const handled = useRef(false)

  return (
    <View style={styles.screen}>
      {permission?.granted ? (
        <CameraView
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            const link = parsePairLink(data)

            if (!link || handled.current) {
              return
            }

            handled.current = true
            router.dismissTo({ params: { code: link.code, host: link.host, port: String(link.port) }, pathname: '/connect' })
          }}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={styles.ask}>
          <Text style={styles.askText}>Hexbot needs the camera to scan the pairing code.</Text>
          {permission?.canAskAgain !== false ? (
            <Button onPress={requestPermission} variant="secondary">
              Allow camera
            </Button>
          ) : null}
        </View>
      )}
      <View pointerEvents="none" style={styles.frameWrap}>
        <View style={styles.frame} />
        <Text style={styles.hint}>Point at the QR code from hexbot pair</Text>
      </View>
      <View style={[styles.close, { top: insets.top + 8 }]}>
        <GlassButton accessibilityLabel="Close" icon="xmark" onPress={() => router.back()} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  ask: { alignItems: 'center', flex: 1, gap: 20, justifyContent: 'center', padding: 32 },
  askText: { color: '#FFFFFF', fontSize: 17, textAlign: 'center' },
  close: { position: 'absolute', right: 16 },
  frame: { borderColor: 'rgba(255,255,255,0.9)', borderRadius: 28, borderWidth: 3, height: 250, width: 250 },
  frameWrap: { alignItems: 'center', bottom: 0, gap: 20, justifyContent: 'center', left: 0, position: 'absolute', right: 0, top: 0 },
  hint: { color: '#FFFFFF', fontSize: 15, fontWeight: '500' },
  screen: { backgroundColor: '#000000', flex: 1 }
})
