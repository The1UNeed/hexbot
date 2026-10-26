import { Ionicons } from '@expo/vector-icons'
import { ScrollView, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { BotFace, Group, Row, Screen, Text, TopBar, useTheme } from '../ui'
import type { BotSummary } from './types'

export interface LibraryScreenProps {
  bots: BotSummary[]
  onBack: () => void
  /** Opens the bot's profile: soul, model, tools, memory. */
  onOpenBot: (id: string) => void
  onNewBot?: () => void
  onOpenJobs?: () => void
  /** Every room, archived ones included. */
  onOpenRooms?: () => void
  archivedRooms?: number
}

/**
 * Bots & jobs: what is not a conversation. Every bot's profile, scheduled
 * jobs, and every room including archived ones.
 */
export function LibraryScreen({
  archivedRooms = 0,
  bots,
  onBack,
  onNewBot,
  onOpenBot,
  onOpenJobs,
  onOpenRooms
}: LibraryScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const sorted = [...bots].sort(
    (a, b) => Number(!!b.primary) - Number(!!a.primary) || a.name.localeCompare(b.name)
  )

  return (
    <Screen background="grouped" testID="library-screen">
      <TopBar onBack={onBack} testID="library-bar" title="Bots & jobs" />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        testID="library-list"
      >
        <Group separatorInset={70} title="Bots">
          {sorted.map(bot => (
            <Row
              chevron
              key={bot.id}
              leading={<BotFace {...bot} size={40} />}
              meta={bot.primary ? 'Primary' : null}
              onPress={() => onOpenBot(bot.id)}
              subtitle={bot.title || bot.description || null}
              testID={`library-bot-${bot.id}`}
              title={bot.name}
            />
          ))}
          {onNewBot ? (
            <Row
              leading={<Ionicons color={theme.accent} name="add-circle" size={40} />}
              onPress={onNewBot}
              testID="library-new-bot"
              title="New bot"
            />
          ) : null}
        </Group>
        {onOpenJobs || onOpenRooms ? (
          <Group separatorInset={56}>
            {onOpenJobs ? (
              <Row
                chevron
                leading={<Ionicons color={theme.text} name="alarm-outline" size={22} />}
                onPress={onOpenJobs}
                testID="library-jobs"
                title="Scheduled jobs"
              />
            ) : null}
            {onOpenRooms ? (
              <Row
                chevron
                leading={<Ionicons color={theme.text} name="people-outline" size={22} />}
                meta={archivedRooms ? `${archivedRooms} archived` : null}
                onPress={onOpenRooms}
                testID="library-rooms"
                title="All rooms"
              />
            ) : null}
          </Group>
        ) : null}
        {!bots.length ? (
          <Text align="center" tone="muted" variant="footnote">
            No bots yet.
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { gap: 24, paddingHorizontal: 16, paddingTop: 8 }
})
