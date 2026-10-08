import { Ionicons } from '@expo/vector-icons'
import { useRef, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  Badge,
  Banner,
  Button,
  type FaceMood,
  FaceDrawing,
  type FaceStyle,
  Field,
  type IconName,
  radius,
  Screen,
  Text,
  useTheme
} from '../ui'
import type { DaemonEntry } from './types'

export type PairingInput =
  { address: string; code: string; mode: 'code' } | { link: string; mode: 'link' }

/** Which action is running, so only its button shows progress. */
export type ConnectionPending = 'connect' | 'demo' | 'pair' | { savedId: string } | null

export interface ConnectionScreenProps {
  saved: DaemonEntry[]
  onOpenSaved: (id: string) => void
  onPair: (input: PairingInput) => void
  /** Sign in through Hex Connect; leave out to hide the option. */
  onConnectSignIn?: () => void
  /** Open the demo; leave out to hide it. */
  onDemo?: () => void
  pending?: ConnectionPending
  error?: string | null
  onDismissError?: () => void
  /** Prefill from a pairing link the app was opened with. */
  initialLink?: string
  initialAddress?: string
  /** Return to the daemon in use; leave out on first run. */
  onCancel?: () => void
}

/** Five faces in a loose huddle above the name: the first thing a new user sees. */
const HUDDLE: { face: FaceStyle; lift: number; mood: FaceMood; size: number }[] = [
  { face: { color: 'teal', shape: 'hexagon' }, lift: 18, mood: 'idle', size: 46 },
  { face: { color: 'violet', shape: 'round' }, lift: 0, mood: 'happy', size: 64 },
  { face: { color: 'pink', shape: 'triangle' }, lift: 26, mood: 'listening', size: 52 },
  { face: { color: 'blue', shape: 'drop' }, lift: 4, mood: 'idle', size: 58 },
  { face: { color: 'amber', shape: 'cloud' }, lift: 22, mood: 'happy', size: 48 }
]

/**
 * First run and "add a daemon": the daemons this app knows, pairing by
 * address and code or by link, Hex Connect, and a clearly labelled demo.
 */
export function ConnectionScreen({
  error,
  initialAddress = '',
  initialLink = '',
  onConnectSignIn,
  onDemo,
  onCancel,
  onDismissError,
  onOpenSaved,
  onPair,
  pending = null,
  saved
}: ConnectionScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [mode, setMode] = useState<'code' | 'link'>(initialLink ? 'link' : 'code')
  const [address, setAddress] = useState(initialAddress)
  const [code, setCode] = useState('')
  const [link, setLink] = useState(initialLink)
  const codeInput = useRef<TextInput>(null)
  const busy = pending !== null
  const ready = mode === 'code' ? address.trim() !== '' && code.trim() !== '' : link.trim() !== ''

  const submit = () => {
    if (!ready || busy) {
      return
    }

    onPair(
      mode === 'code'
        ? { address: address.trim(), code: code.trim(), mode }
        : { link: link.trim(), mode }
    )
  }

  const tiles: { key: 'code' | 'connect' | 'link'; label: string; icon: IconName }[] = [
    { icon: 'keypad-outline', key: 'code', label: 'Address and code' },
    { icon: 'link-outline', key: 'link', label: 'Pairing link' },
    ...(onConnectSignIn
      ? [{ icon: 'cloud-outline' as IconName, key: 'connect' as const, label: 'Hex Connect' }]
      : [])
  ]

  return (
    <Screen avoidKeyboard edges={['bottom', 'left', 'right']} testID="connection-screen">
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.hero, { paddingTop: insets.top + 28 }]}>
          {onCancel ? (
            <Pressable
              accessibilityLabel="Cancel"
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [
                styles.cancel,
                { top: insets.top + 6, opacity: pressed ? 0.6 : 1 }
              ]}
              testID="connection-cancel"
            >
              <Text style={styles.cancelText} variant="headline">
                Cancel
              </Text>
            </Pressable>
          ) : null}
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.huddle}
          >
            {HUDDLE.map((item, index) => (
              <View key={index} style={{ marginTop: item.lift }}>
                <FaceDrawing mood={item.mood} size={item.size} style={item.face} />
              </View>
            ))}
          </View>
          <Text accessibilityRole="header" style={styles.wordmark} variant="largeTitle">
            Hexbot
          </Text>
          <Text style={styles.heroLine} variant="callout">
            Connect to the daemon that runs your bots.
          </Text>
        </View>

        <View style={styles.content}>
          {error ? (
            <Banner
              actionLabel={onDismissError ? 'Dismiss' : undefined}
              message={error}
              onAction={onDismissError}
              testID="connection-error"
              title="Could not connect"
            />
          ) : null}

          {saved.length > 0 ? (
            <View style={styles.saved}>
              <Text accessibilityRole="header" style={styles.label} tone="muted" variant="footnote">
                Your daemons
              </Text>
              {saved.map(daemon => {
                const opening = typeof pending === 'object' && pending?.savedId === daemon.id

                return (
                  <Pressable
                    accessibilityHint="Connects to this daemon"
                    accessibilityLabel={`${daemon.name}, ${daemon.via === 'connect' ? 'Hex Connect' : 'local network'}`}
                    accessibilityRole="button"
                    disabled={busy && !opening}
                    key={daemon.id}
                    onPress={() => onOpenSaved(daemon.id)}
                    style={({ pressed }) => [
                      styles.savedRow,
                      {
                        backgroundColor: pressed ? theme.pressed : theme.surface,
                        borderColor: theme.hairline,
                        opacity: busy && !opening ? 0.45 : 1
                      }
                    ]}
                    testID={`connection-saved-${daemon.id}`}
                  >
                    <DaemonGlyph via={daemon.via} />
                    <View style={styles.savedText}>
                      <Text numberOfLines={1} variant="headline">
                        {daemon.name}
                      </Text>
                      <Text numberOfLines={1} tone="muted" variant="footnote">
                        {daemon.via === 'connect'
                          ? `Hex Connect, ${daemon.address}`
                          : `Local network, ${daemon.address}`}
                      </Text>
                    </View>
                    <View style={[styles.connectPill, { backgroundColor: theme.ink }]}>
                      <Text style={{ color: theme.onInk }} variant="subhead">
                        {opening ? 'Connecting…' : 'Connect'}
                      </Text>
                    </View>
                  </Pressable>
                )
              })}
            </View>
          ) : null}

          <View style={styles.tiles} accessibilityRole="tablist">
            {tiles.map(tile => {
              const selected = tile.key === mode
              const connecting = tile.key === 'connect' && pending === 'connect'
              return (
                <Pressable
                  accessibilityLabel={tile.label}
                  accessibilityRole={tile.key === 'connect' ? 'button' : 'tab'}
                  accessibilityState={{ busy: connecting, disabled: busy && !connecting, selected }}
                  disabled={busy && !connecting}
                  key={tile.key}
                  onPress={() => (tile.key === 'connect' ? onConnectSignIn?.() : setMode(tile.key))}
                  style={({ pressed }) => [
                    styles.tile,
                    {
                      backgroundColor: selected ? theme.ink : theme.surface,
                      borderColor: selected ? theme.ink : theme.hairline,
                      opacity: busy && !connecting ? 0.45 : pressed ? 0.7 : 1
                    }
                  ]}
                  testID={
                    tile.key === 'connect'
                      ? 'connection-hex-connect'
                      : `connection-mode-${tile.key}`
                  }
                >
                  <Ionicons
                    color={selected ? theme.onInk : theme.text}
                    name={tile.icon}
                    size={22}
                  />
                  <Text
                    maxFontSizeMultiplier={1.3}
                    numberOfLines={2}
                    style={{ color: selected ? theme.onInk : theme.text }}
                    variant="subhead"
                  >
                    {connecting ? 'Opening…' : tile.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          <View
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.hairline }]}
          >
            {mode === 'code' ? (
              <>
                <Field
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  editable={!busy}
                  inputMode="url"
                  label="Address"
                  onChangeText={setAddress}
                  onSubmitEditing={() => codeInput.current?.focus()}
                  placeholder="192.168.1.20:9119"
                  returnKeyType="next"
                  submitBehavior="submit"
                  testID="connection-address"
                  value={address}
                />
                <Field
                  autoCapitalize="none"
                  autoComplete="one-time-code"
                  autoCorrect={false}
                  editable={!busy}
                  hint="Run hexbot pair on the daemon's computer, or open Settings, Devices in the app there."
                  label="Pairing code"
                  onChangeText={setCode}
                  onSubmitEditing={submit}
                  ref={codeInput}
                  returnKeyType="go"
                  testID="connection-code"
                  textContentType="oneTimeCode"
                  value={code}
                />
              </>
            ) : (
              <Field
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                hint="Paste the hexbot://pair link from the daemon's computer."
                inputMode="url"
                label="Pairing link"
                onChangeText={setLink}
                onSubmitEditing={submit}
                placeholder="hexbot://pair?host=…"
                returnKeyType="go"
                testID="connection-link"
                value={link}
              />
            )}
            <Button
              busy={pending === 'pair'}
              busyLabel="Pairing…"
              disabled={!ready || (busy && pending !== 'pair')}
              label="Pair"
              onPress={submit}
              testID="connection-pair"
              wide
            />
          </View>
          {onConnectSignIn ? (
            <Text style={styles.label} tone="muted" variant="footnote">
              Hex Connect reaches your daemon from outside your network. Chat goes straight to the
              daemon.
            </Text>
          ) : null}

          {onDemo ? (
            <Pressable
              accessibilityHint="Opens sample bots on this phone without a daemon"
              accessibilityLabel="Try the demo"
              accessibilityRole="button"
              accessibilityState={{ busy: pending === 'demo', disabled: busy }}
              disabled={busy}
              onPress={onDemo}
              style={({ pressed }) => [
                styles.demo,
                {
                  borderColor: theme.hairline,
                  opacity: busy && pending !== 'demo' ? 0.45 : pressed ? 0.7 : 1
                }
              ]}
              testID="connection-demo"
            >
              <View style={styles.demoText}>
                <View style={styles.demoTitle}>
                  <Text variant="headline">
                    {pending === 'demo' ? 'Opening the demo…' : 'Try the demo'}
                  </Text>
                  <Badge label="Demo" tone="warning" />
                </View>
                <Text tone="muted" variant="footnote">
                  Sample bots and made-up replies. Nothing connects to a daemon.
                </Text>
              </View>
              <Ionicons color={theme.faint} name="chevron-forward" size={18} />
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  )
}

/** A daemon's icon in a list: how the app reaches it. */
export function DaemonGlyph({ via }: { via: DaemonEntry['via'] }) {
  const theme = useTheme()
  const icon =
    via === 'connect' ? 'globe-outline' : via === 'demo' ? 'flask-outline' : 'desktop-outline'

  return (
    <View style={[styles.glyph, { backgroundColor: theme.fill }]}>
      <Ionicons color={theme.text} name={icon} size={20} />
    </View>
  )
}

const HERO = '#0f0f13'

const styles = StyleSheet.create({
  cancel: {
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 16,
    position: 'absolute',
    right: 4
  },
  cancelText: { color: '#ffffff' },
  card: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, gap: 16, padding: 18 },
  connectPill: {
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: 14
  },
  content: { gap: 18, paddingHorizontal: 20, paddingTop: 22 },
  demo: {
    alignItems: 'center',
    borderRadius: 18,
    borderStyle: 'dashed',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  demoText: { flex: 1, gap: 2 },
  demoTitle: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  glyph: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40
  },
  hero: {
    alignItems: 'center',
    backgroundColor: HERO,
    borderBottomLeftRadius: 36,
    borderBottomRightRadius: 36,
    gap: 6,
    paddingBottom: 30,
    paddingHorizontal: 24
  },
  heroLine: { color: '#b4b4bb', textAlign: 'center' },
  huddle: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    marginBottom: 10
  },
  label: { paddingHorizontal: 4 },
  saved: { gap: 8 },
  savedRow: {
    alignItems: 'center',
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 68,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  savedText: { flex: 1, gap: 1 },
  scroll: { paddingBottom: 32 },
  tile: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 10,
    minHeight: 92,
    padding: 12
  },
  tiles: { flexDirection: 'row', gap: 8 },
  wordmark: { color: '#ffffff', fontSize: 40, letterSpacing: -0.5, lineHeight: 46 }
})
