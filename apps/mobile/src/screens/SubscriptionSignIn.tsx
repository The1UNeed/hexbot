import { useEffect, useRef, useState } from 'react'
import { Linking, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'

import type { ProviderLogin } from '../../../web/src/lib/types'
import type { Rpc } from '../core/types'
import { Button, mono, Text } from '../ui'

/** Whose sign-in page opens: shorter than the provider label. */
const SIGN_IN_NAMES: Record<string, string> = { 'xai-oauth': 'xAI' }

/**
 * A provider that works through a subscription the user signs in to, such
 * as SuperGrok for X search, instead of a key. `grant` is the model provider
 * whose browser sign-in it shares. As in the web app: start the sign-in,
 * show the code, and check every few seconds until it is done.
 */
export function SubscriptionSignIn({
  configured,
  grant,
  label,
  onRenewingChange,
  onSignedIn,
  renewing: renewingProp,
  rpc,
  style,
  testID
}: {
  configured: boolean
  grant: string
  label: string
  /** The parent hides its own button while a sign-in is renewed. */
  onRenewingChange?: (renewing: boolean) => void
  onSignedIn?: () => void
  renewing?: boolean
  rpc: Rpc
  /** The sign-in button's style, to match a card's own buttons. */
  style?: StyleProp<ViewStyle>
  testID: string
}) {
  const [login, setLogin] = useState<ProviderLogin | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Signing in again renews a sign-in that expired or was revoked.
  const [ownRenewing, setOwnRenewing] = useState(false)
  const renewing = renewingProp ?? ownRenewing
  const setRenewing = onRenewingChange ?? setOwnRenewing
  const done = configured && !renewing
  const pending = login?.status === 'pending' ? login.login_id : null
  const active = useRef<string | null>(null)
  active.current = pending
  // The latest callbacks, so a parent that re-renders often never restarts the poll.
  const latest = useRef({ onSignedIn, setRenewing })
  latest.current = { onSignedIn, setRenewing }

  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => {
      void rpc<ProviderLogin>('hexbot.providers.login_poll', { login_id: pending })
        .then(next => {
          setLogin(next)
          if (next.status === 'done') {
            latest.current.setRenewing(false)
            latest.current.onSignedIn?.()
          }
          if (next.status === 'error')
            setError(next.message || 'The sign-in did not finish. Try again.')
        })
        .catch(reason => setError(String(reason)))
    }, 3_000)
    return () => clearInterval(timer)
  }, [pending, rpc])

  // A sign-in still waiting when the card or page goes away is cancelled.
  useEffect(
    () => () => {
      if (active.current)
        void rpc('hexbot.providers.login_cancel', { login_id: active.current }).catch(
          () => undefined
        )
    },
    [rpc]
  )

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const started = await rpc<ProviderLogin>('hexbot.providers.login_start', { provider: grant })
      setLogin(started)
      if (started.supported === false || started.status === 'error') setError(started.message)
      else if (started.url) await Linking.openURL(started.url)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  if (done)
    return (
      <View style={styles.row}>
        <Text tone="muted" variant="footnote" testID={`${testID}-done`}>
          Signed in.
        </Text>
        <Button
          label="Sign in again"
          onPress={() => {
            setLogin(null)
            setRenewing(true)
          }}
          size="small"
          testID={`${testID}-again`}
          variant="plain"
        />
      </View>
    )

  return (
    <View style={styles.stack}>
      {pending && login ? (
        <>
          <Text tone="muted" variant="footnote">
            Finish in your browser. If it asks for a code, enter this one:
          </Text>
          <Text selectable style={styles.code} testID={`${testID}-code`}>
            {login.code}
          </Text>
          <View style={styles.row}>
            <Button
              label="Open again"
              onPress={() => void Linking.openURL(login.url)}
              size="small"
              testID={`${testID}-reopen`}
              variant="secondary"
            />
            <Button
              label="Cancel sign-in"
              onPress={() => {
                void rpc('hexbot.providers.login_cancel', { login_id: login.login_id }).catch(
                  () => undefined
                )
                setLogin(null)
              }}
              size="small"
              testID={`${testID}-cancel`}
              variant="plain"
            />
          </View>
        </>
      ) : (
        <Button
          accessibilityLabel={`Sign in with ${SIGN_IN_NAMES[grant] ?? label}`}
          busy={busy}
          label="Sign in"
          onPress={() => void start()}
          style={style}
          testID={testID}
        />
      )}
      {configured && renewing && !pending ? (
        <Button
          label="Keep the current sign-in"
          onPress={() => setRenewing(false)}
          size="small"
          testID={`${testID}-keep`}
          variant="plain"
        />
      ) : null}
      {error ? (
        <Text tone="danger" variant="footnote">
          {error}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  code: { fontFamily: mono, fontSize: 20, letterSpacing: 3 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  stack: { gap: 8 }
})
