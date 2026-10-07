/**
 * One bot settings page inside the bot sheet: the native title, one muted
 * line saying what the page is for, then grouped lists. Waits for the bot
 * and says so when it is gone.
 */

import { Stack, useNavigation } from 'expo-router'
import type { ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import type { Bot, BotUpdatePatch } from '../../lib/types'
import { useTheme } from '../../theme'
import { ListScroll } from '../list'

import { useBotSheet } from './nav'
import { useBotRoute, useBotSave } from './use-bot'

export interface BotPageContext {
  bot: Bot
  error: null | string
  quietly: (patch: BotUpdatePatch) => void
  save: (patch: BotUpdatePatch) => Promise<Bot>
  setError: (error: null | string) => void
}

export function BotPage({
  children,
  lead,
  scroll = true,
  title
}: {
  children: (context: BotPageContext) => ReactNode
  lead?: string
  /** False for a page that lays itself out (the soul editor). */
  scroll?: boolean
  title: string
}) {
  const { colors } = useTheme()
  const { bot, loaded, name } = useBotRoute()
  const actions = useBotSave(name)
  const sheet = useBotSheet()
  // Opened straight from a link (a "Fix" action in a chat), the page is first in the sheet: give it a way out.
  const first = useNavigation().getState()?.index === 0

  const body = !bot ? (
    <View style={styles.center}>
      {loaded ? <Text style={{ color: colors.textMuted, fontSize: 17 }}>This bot is gone.</Text> : <ActivityIndicator color={colors.textMuted} />}
    </View>
  ) : scroll ? (
    <ListScroll>
      {lead ? <Lead text={lead} /> : null}
      {children({ bot, ...actions })}
      {actions.error ? <Text style={[styles.error, { color: colors.danger }]}>{actions.error}</Text> : null}
    </ListScroll>
  ) : (
    children({ bot, ...actions })
  )

  return (
    <>
      <Stack.Screen options={{ title }} />
      {first ? (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button accessibilityLabel="Close" icon="xmark" onPress={() => sheet.close()} />
        </Stack.Toolbar>
      ) : null}
      {body}
    </>
  )
}

export function Lead({ text }: { text: string }) {
  const { colors } = useTheme()

  return <Text style={[styles.lead, { color: colors.textMuted }]}>{text}</Text>
}

/** Centred muted text for an empty or failed list. */
export function Note({ danger, text }: { danger?: boolean; text: string }) {
  const { colors } = useTheme()

  return <Text style={[styles.note, { color: danger ? colors.danger : colors.textMuted }]}>{text}</Text>
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  error: { fontSize: 14, textAlign: 'center' },
  lead: { fontSize: 15, lineHeight: 20, marginBottom: -8, paddingHorizontal: 16 },
  note: { fontSize: 15, lineHeight: 20, paddingHorizontal: 24, paddingVertical: 16, textAlign: 'center' }
})
