import { Stack } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'

import { useBotSheet } from '../../../components/bot/nav'
import { BotPage, Note } from '../../../components/bot/page'
import { errorText } from '../../../components/bot/use-bot'
import { Icon } from '../../../components/icon'
import { Group, Row } from '../../../components/list'
import { rowTime } from '../../../lib/format'
import { freshSection } from '../../../lib/navigation'
import { toMillis } from '../../../lib/time'
import type { Bot, Section } from '../../../lib/types'
import { useBots } from '../../../stores/bots'
import { sectionsActions, useSectionsForBot } from '../../../stores/sections'
import { type Palette, useTheme } from '../../../theme'

export default function Sections() {
  return (
    <BotPage lead="Every conversation with this bot. Archiving keeps its history; deleting removes it. Swipe a row for both." title="Sections">
      {({ bot }) => <SectionList bot={bot} />}
    </BotPage>
  )
}

function SectionList({ bot }: { bot: Bot }) {
  const { colors } = useTheme()
  const sheet = useBotSheet()
  const sections = useSectionsForBot(bot.name)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    // Unfiltered on purpose: a `bot` filter would replace every other bot's sections in the store.
    void sectionsActions()
      .refresh()
      .catch(caught => setError(errorText(caught)))
      .finally(() => setLoaded(true))
  }, [bot.name])

  const sorted = useMemo(
    () => [...sections].sort((a, b) => toMillis(b.updated_at ?? b.created_at) - toMillis(a.updated_at ?? a.created_at)),
    [sections]
  )

  const open = sorted.filter(section => !section.archived_at)
  const archived = sorted.filter(section => section.archived_at)

  const act = (work: Promise<unknown>) => {
    setError(null)
    void work
      .then(() => useBots.getState().refreshOne(bot.name))
      .catch(caught => setError(errorText(caught)))
  }

  const remove = (section: Section) =>
    Alert.alert(`Delete “${section.title}”?`, 'Its history goes with it. Memory stays.', [
      { style: 'cancel', text: 'Cancel' },
      { onPress: () => act(sectionsActions().remove(section.id)), style: 'destructive', text: 'Delete' }
    ])

  const start = async () => {
    setStarting(true)
    setError(null)

    try {
      const section = await freshSection(bot.name)

      sheet.openAfterClose(section.id)
    } catch (caught) {
      setError(errorText(caught))
      setStarting(false)
    }
  }

  const row = (section: Section) => (
    <SectionRow
      colors={colors}
      key={section.id}
      onArchive={() => act(section.archived_at ? sectionsActions().unarchive(section.id) : sectionsActions().archive(section.id))}
      onDelete={() => remove(section)}
      onOpen={() => sheet.openAfterClose(section.id)}
      section={section}
    />
  )

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button accessibilityLabel="New section" disabled={starting} icon="square.and.pencil" onPress={() => void start()} />
      </Stack.Toolbar>
      {error ? <Note danger text={error} /> : null}
      {loaded || open.length ? (
        <Group footer={open.length ? undefined : 'No open sections. The pencil starts a new one.'} label="Open">
          {open.map(row)}
        </Group>
      ) : (
        <Group label="Open">
          <Row loading title="Loading" />
        </Group>
      )}
      {archived.length ? <Group label="Archived">{archived.map(row)}</Group> : null}
    </>
  )
}

const ACTION = 84

function SectionRow({
  colors,
  onArchive,
  onDelete,
  onOpen,
  section
}: {
  colors: Palette
  onArchive: () => void
  onDelete: () => void
  onOpen: () => void
  section: Section
}) {
  const archived = Boolean(section.archived_at)
  const detail = [
    rowTime(section.updated_at ?? section.created_at),
    section.message_count ? `${section.message_count} ${section.message_count === 1 ? 'message' : 'messages'}` : 'Empty'
  ]
    .filter(Boolean)
    .join(' · ')

  const actions = (methods: SwipeableMethods) => (
    <View style={styles.actions}>
      <Pressable
        accessibilityLabel={archived ? 'Unarchive' : 'Archive'}
        accessibilityRole="button"
        onPress={() => {
          methods.close()
          onArchive()
        }}
        style={[styles.action, { backgroundColor: colors.textMuted }]}
        testID={`section-${archived ? 'unarchive' : 'archive'}-${section.id}`}
      >
        <Icon color="#FFFFFF" name={archived ? 'tray.and.arrow.up' : 'archivebox'} size={20} />
        <Text style={styles.actionText}>{archived ? 'Unarchive' : 'Archive'}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Delete"
        accessibilityRole="button"
        onPress={() => {
          methods.close()
          onDelete()
        }}
        style={[styles.action, { backgroundColor: colors.danger }]}
        testID={`section-delete-${section.id}`}
      >
        <Icon color="#FFFFFF" name="trash" size={20} />
        <Text style={styles.actionText}>Delete</Text>
      </Pressable>
    </View>
  )

  return (
    <ReanimatedSwipeable
      friction={1.6}
      overshootRight={false}
      renderRightActions={(_progress, _translation, methods) => actions(methods)}
      rightThreshold={40}
    >
      <View style={{ backgroundColor: colors.bubbleBot }}>
        <Row
          chevron
          onLongPress={() =>
            Alert.alert(section.title, undefined, [
              { onPress: onArchive, text: archived ? 'Unarchive' : 'Archive' },
              { onPress: onDelete, style: 'destructive', text: 'Delete' },
              { style: 'cancel', text: 'Cancel' }
            ])
          }
          onPress={onOpen}
          subtitle={section.preview?.trim() ? `${detail} · ${section.preview.trim()}` : detail}
          testID={`section-${section.id}`}
          title={section.title || 'New section'}
        />
      </View>
    </ReanimatedSwipeable>
  )
}

const styles = StyleSheet.create({
  action: { alignItems: 'center', gap: 4, justifyContent: 'center', width: ACTION },
  actionText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  actions: { flexDirection: 'row' }
})
