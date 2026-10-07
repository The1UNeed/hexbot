import Constants from 'expo-constants'
import * as Linking from 'expo-linking'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Button } from '../components/button'
import { GlassButton } from '../components/glass'
import { HexbotMark } from '../components/mark'
import { connectTo, pairingErrorMessage, pairWithDaemon } from '../lib/connection'
import { formatAddress, parseAddress, parsePairLink } from '../lib/pair-link'
import { useConnection } from '../stores/connection'
import { type Palette, useTheme } from '../theme'

/**
 * Pair this phone with a daemon: its address (LAN or Tailscale) and the
 * one-time code from `hexbot pair` or Settings, Network. A `hexbot://pair`
 * link fills both, whether pasted, scanned, or opened from the camera.
 */
export default function Connect() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ code?: string; host?: string; port?: string }>()
  const notice = useConnection(state => (state.status === 'unauthorized' ? state.error : null))
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const codeRef = useRef<TextInput>(null)
  const url = Linking.useLinkingURL()

  useEffect(() => {
    if (params.host) {
      setAddress(formatAddress({ host: params.host, port: Number(params.port) || 9119 }))
    }

    if (params.code) {
      setCode(params.code)
    }
  }, [params.code, params.host, params.port])

  useEffect(() => {
    const link = url ? parsePairLink(url) : null

    if (link) {
      setAddress(formatAddress(link))
      setCode(link.code)
    }
  }, [url])

  function onAddressChange(value: string) {
    const link = parsePairLink(value)

    if (link) {
      setAddress(formatAddress(link))
      setCode(link.code)

      return
    }

    setAddress(value)
  }

  async function submit() {
    const parts = parseAddress(address)

    if (!parts) {
      setError('Enter the address of the computer running Hexbot.')

      return
    }

    if (code.trim().length < 4) {
      setError('Enter the pairing code.')
      codeRef.current?.focus()

      return
    }

    setBusy(true)
    setError(null)

    try {
      const { target } = await pairWithDaemon({
        code,
        deviceName: Constants.deviceName ?? 'Phone',
        host: parts.host,
        port: parts.port,
        tls: /^https:\/\//i.test(address.trim()) || parts.port === 443
      })

      await connectTo(target)
    } catch (reason) {
      setError(pairingErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const s = styles(colors)

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <KeyboardAwareScrollView bottomOffset={24} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={s.mark}>
          <HexbotMark size={88} />
        </View>
        <Text style={s.title}>Connect to Hexbot</Text>
        <Text style={s.lead}>
          On the computer running Hexbot, run <Text style={s.code}>hexbot pair</Text> or open Settings, Network, then enter the address
          and code here.
        </Text>

        {notice ? <Text style={s.notice}>{notice}</Text> : null}

        <View style={s.card}>
          <View style={s.row}>
            <Text style={s.label}>Address</Text>
            <TextInput
              accessibilityLabel="Address"
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="url"
              onChangeText={onAddressChange}
              onSubmitEditing={() => codeRef.current?.focus()}
              placeholder="192.168.1.20:9119"
              placeholderTextColor={colors.textFaint}
              returnKeyType="next"
              style={s.input}
              testID="connect-address"
              value={address}
            />
          </View>
          <View style={s.divider} />
          <View style={s.row}>
            <Text style={s.label}>Code</Text>
            <TextInput
              accessibilityLabel="Pairing code"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect={false}
              onChangeText={setCode}
              onSubmitEditing={submit}
              placeholder="ABCD-1234"
              placeholderTextColor={colors.textFaint}
              ref={codeRef}
              returnKeyType="go"
              style={[s.input, s.mono]}
              testID="connect-code"
              value={code}
            />
          </View>
        </View>

        {error ? (
          <Text accessibilityLiveRegion="polite" style={s.error} testID="connect-error">
            {error}
          </Text>
        ) : null}

        <Button loading={busy} onPress={submit} style={s.submit}>
          Connect
        </Button>

        <View style={s.scan}>
          <GlassButton accessibilityLabel="Scan a pairing code" icon="qrcode.viewfinder" onPress={() => router.push('/scan')} size={52} />
          <Text style={s.scanLabel}>Scan the QR code</Text>
        </View>

        <Text style={s.foot}>Over the internet, connect through Tailscale with the daemon’s Tailscale address.</Text>
      </KeyboardAwareScrollView>
    </View>
  )
}

const styles = (colors: Palette) =>
  StyleSheet.create({
    card: { backgroundColor: colors.surface, borderRadius: 16, marginTop: 28, paddingHorizontal: 16 },
    code: { fontFamily: 'Menlo', fontSize: 15 },
    content: { paddingBottom: 40, paddingHorizontal: 24, paddingTop: 48 },
    divider: { backgroundColor: colors.hairline, height: StyleSheet.hairlineWidth },
    error: { color: colors.danger, fontSize: 15, marginTop: 14, textAlign: 'center' },
    foot: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 32, textAlign: 'center' },
    input: { color: colors.text, flex: 1, fontSize: 17, height: 52 },
    label: { color: colors.text, fontSize: 17, width: 84 },
    lead: { color: colors.textMuted, fontSize: 16, lineHeight: 22, marginTop: 10, textAlign: 'center' },
    mark: { alignItems: 'center' },
    mono: { fontFamily: 'Menlo', letterSpacing: 1 },
    notice: { color: colors.danger, fontSize: 15, marginTop: 18, textAlign: 'center' },
    row: { alignItems: 'center', flexDirection: 'row' },
    scan: { alignItems: 'center', gap: 8, marginTop: 28 },
    scanLabel: { color: colors.textMuted, fontSize: 13 },
    screen: { backgroundColor: colors.bg, flex: 1 },
    submit: { marginTop: 20 },
    title: { color: colors.text, fontSize: 28, fontWeight: '700', marginTop: 20, textAlign: 'center' }
  })
