import * as Clipboard from 'expo-clipboard'
import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { Alert, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native'

import { Group, Row } from '../../components/list'
import { Cell, Chip, errorText, Initials, KeyboardListScroll, Lead, MONO, PageState, PillButton, useOnReconnect } from '../../components/settings/kit'
import { QrCode } from '../../components/settings/qr'
import { usersInvite, usersUpdate } from '../../lib/api'
import { toMillis } from '../../lib/time'
import type { User } from '../../lib/types'
import { useSettings } from '../../stores/settings'
import { useUsers } from '../../stores/users'
import { useTheme } from '../../theme'

type Role = User['role']

const disabledOf = (user: User) => Boolean(user.disabled_at ?? user.disabled)

/** Users, for admins: invite someone with a role, then change roles or disable people. */
export default function Users() {
  const { colors } = useTheme()
  const me = useUsers(state => state.current)
  const users = useUsers(state => state.users)
  const refresh = useUsers(state => state.refresh)
  const network = useSettings(state => state.network)
  const [loaded, setLoaded] = useState(users.length > 0)
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [inviting, setInviting] = useState(false)
  const [invite, setInvite] = useState<{ code: string; expires_at: number; name: string } | null>(null)
  const [error, setError] = useState<null | string>(null)
  const [peopleError, setPeopleError] = useState<null | string>(null)
  const [busy, setBusy] = useState<null | string>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void refresh().then(() => setLoaded(true))
    void useSettings
      .getState()
      .refreshNetwork()
      .catch(() => undefined)
  }, [refresh])
  useOnReconnect(refresh)

  useEffect(() => {
    if (!invite) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [invite])

  if (loaded && me?.role !== 'admin') {
    return (
      <>
        <Stack.Screen options={{ title: 'Users' }} />
        <PageState error="Only admins can manage users." />
      </>
    )
  }

  const send = async () => {
    const displayName = name.trim()

    if (!displayName) {
      return
    }

    setInviting(true)
    setError(null)

    try {
      const result = await usersInvite(displayName, role)

      setInvite({ code: result.code, expires_at: result.expires_at, name: displayName })
      setNow(Date.now())
      setName('')
      setRole('member')
      void refresh()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setInviting(false)
    }
  }

  const update = async (user: User, patch: Parameters<typeof usersUpdate>[1]) => {
    setBusy(user.id)
    setPeopleError(null)

    try {
      await usersUpdate(user.id, patch)
      await refresh()
    } catch (caught) {
      setPeopleError(errorText(caught))
    } finally {
      setBusy(null)
    }
  }

  const manage = (user: User) => {
    const disabled = disabledOf(user)

    Alert.alert(user.display_name, user.id === me?.id ? 'This is you.' : undefined, [
      {
        onPress: () => void update(user, { role: user.role === 'admin' ? 'member' : 'admin' }),
        text: user.role === 'admin' ? 'Make member' : 'Make admin'
      },
      {
        onPress: () => void update(user, { disabled: !disabled }),
        style: disabled ? 'default' : 'destructive',
        text: disabled ? 'Enable' : 'Disable'
      },
      { style: 'cancel', text: 'Cancel' }
    ])
  }

  const address = network?.lan_enabled ? network.addresses[0] : undefined
  const link = invite && address ? `hexbot://pair?host=${encodeURIComponent(address)}&port=${network?.port}#code=${encodeURIComponent(invite.code)}` : null
  const seconds = invite ? Math.max(0, Math.ceil((toMillis(invite.expires_at) - now) / 1000)) : 0
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <>
      <Stack.Screen options={{ title: 'Users' }} />
      <KeyboardListScroll bottomOffset={140} testID="users">
        <Lead>Invite the people in your household. Each person has their own bots and About you.</Lead>
        {!loaded ? (
          <PageState />
        ) : (
          <>
            <Group error={error} label="Invite">
              <Cell>
                <TextInput
                  accessibilityLabel="Name"
                  autoCapitalize="words"
                  onChangeText={setName}
                  onSubmitEditing={() => void send()}
                  placeholder="Name"
                  placeholderTextColor={colors.textFaint}
                  returnKeyType="send"
                  style={[styles.input, { color: colors.text }]}
                  testID="users-invite-name"
                  value={name}
                />
              </Cell>
              <Cell>
                <Text style={[styles.title, styles.grow, { color: colors.text }]}>Role</Text>
                <View accessibilityRole="radiogroup" style={[styles.segments, { backgroundColor: colors.surface3 }]}>
                  {(['member', 'admin'] as Role[]).map(item => (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: role === item }}
                      key={item}
                      onPress={() => setRole(item)}
                      style={[styles.segment, role === item && { backgroundColor: colors.bg }]}
                      testID={`users-invite-${item}`}
                    >
                      <Text style={[styles.segmentText, { color: role === item ? colors.text : colors.textMuted }]}>
                        {item === 'admin' ? 'Admin' : 'Member'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Cell>
              <Row disabled={!name.trim() || inviting} loading={inviting} onPress={() => void send()} testID="users-invite-send" title="Create invite code" />
            </Group>

            {invite ? (
              <Group label={`Invite for ${invite.name}`} testID="users-invite-card">
                <View style={styles.card}>
                  {link && seconds > 0 ? <QrCode size={168} value={link} /> : null}
                  <Text selectable style={[styles.code, { color: seconds > 0 ? colors.text : colors.textFaint }]} testID="users-invite-code">
                    {invite.code}
                  </Text>
                  <Text style={[styles.hint, { color: seconds > 0 ? colors.textMuted : colors.danger }]}>
                    {seconds > 0
                      ? `${link ? 'Scan with Hexbot on their phone, or enter the code' : 'Enter this code in Hexbot on their device'}. Expires in ${clock}.`
                      : 'This code has expired. Create a new one.'}
                  </Text>
                  {seconds > 0 ? (
                    <View style={styles.actions}>
                      <PillButton onPress={() => void Clipboard.setStringAsync(link ?? invite.code)}>{link ? 'Copy link' : 'Copy code'}</PillButton>
                      <PillButton onPress={() => void Share.share({ message: link ?? invite.code }).catch(() => undefined)}>Share</PillButton>
                    </View>
                  ) : null}
                </View>
              </Group>
            ) : null}

            <Group error={peopleError} footer="Tap a person to change their role or disable them." label="People">
              {users.map(user => {
                const disabled = disabledOf(user)

                return (
                  <Cell key={user.id} onPress={() => manage(user)} style={styles.person} testID={`user-${user.id}`}>
                    <Initials faded={disabled} name={user.display_name} size={36} />
                    <View style={styles.grow}>
                      <Text numberOfLines={1} style={[styles.title, { color: disabled ? colors.textMuted : colors.text }]}>
                        {user.display_name}
                      </Text>
                      <Text style={[styles.sub, { color: colors.textMuted }]}>
                        {user.role === 'admin' ? 'Admin' : 'Member'}
                        {user.id === me?.id ? ' · You' : ''}
                      </Text>
                    </View>
                    {busy === user.id ? <Chip>Saving</Chip> : disabled ? <Chip>Disabled</Chip> : null}
                  </Cell>
                )
              })}
            </Group>
          </>
        )}
      </KeyboardListScroll>
    </>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  card: { alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 24 },
  code: { fontFamily: MONO, fontSize: 28, fontWeight: '600', letterSpacing: 3 },
  grow: { flex: 1, minWidth: 0 },
  hint: { fontSize: 14, lineHeight: 19, textAlign: 'center' },
  input: { flex: 1, fontSize: 17, height: 52 },
  person: { paddingVertical: 10 },
  segment: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  segmentText: { fontSize: 14, fontWeight: '600' },
  segments: { borderRadius: 999, flexDirection: 'row', padding: 2 },
  sub: { fontSize: 14 },
  title: { fontSize: 17, lineHeight: 22 }
})
