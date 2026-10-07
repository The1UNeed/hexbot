import { router, Stack } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, SectionList, StyleSheet, Text, type TextStyle, View } from 'react-native'
import type { SearchBarCommands } from 'react-native-screens'

import { BotFace, RoomCluster } from '../components/face'
import { closeSheet } from '../components/settings/kit'
import { rowTime } from '../lib/format'
import { openBot, openSection, touched } from '../lib/navigation'
import { toMillis } from '../lib/time'
import type { Bot, Room, Section } from '../lib/types'
import { useBotList, useBots } from '../stores/bots'
import { useDrafts } from '../stores/drafts'
import { useRoomList } from '../stores/rooms'
import { isThread, sectionsActions, useSections } from '../stores/sections'
import { type Palette, useTheme } from '../theme'

type Item = { bot: Bot; kind: 'bot' } | { kind: 'room'; room: Room } | { kind: 'section'; section: Section }

interface Group {
  data: Item[]
  title: string
}

const RECENT = 12
const MAX_SECTIONS = 40
const FACE = 40

const has = (text: null | string | undefined, needle: string) => Boolean(text) && (text as string).toLowerCase().includes(needle)

/** The part of a preview around the match, so the match is on screen. */
function around(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = needle ? flat.toLowerCase().indexOf(needle) : -1

  return at > 28 ? `…${flat.slice(at - 18)}` : flat
}

/**
 * Search: bots, rooms and sections, matched on names, labels, titles and
 * previews. With no query it lists recent sections. A result closes the
 * search and opens where it points.
 */
export default function Search() {
  const { colors } = useTheme()
  const bots = useBotList()
  const byName = useBots(state => state.byName)
  const rooms = useRoomList()
  const byId = useSections(state => state.byId)
  const drafts = useDrafts(state => state.byId)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const s = styles(colors)

  const bar = useRef<SearchBarCommands>(null)

  // `autoFocus` is not honoured inside a sheet; focus once the sheet has settled.
  useEffect(() => {
    const timer = setTimeout(() => bar.current?.focus(), 700)

    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    void sectionsActions().refresh()

    if (!useBots.getState().loaded) {
      void useBots.getState().refresh()
    }
  }, [])

  const sections = useMemo(
    () =>
      Object.values(byId)
        .filter(section => !isThread(section) && section.title !== 'Dreams' && touched(section, drafts) && byName[section.bot])
        .sort((a, b) => toMillis(b.updated_at) - toMillis(a.updated_at)),
    [byId, byName, drafts]
  )

  const groups = useMemo<Group[]>(() => {
    if (!needle) {
      const recent = sections.filter(section => !section.archived_at).slice(0, RECENT)

      return recent.length ? [{ data: recent.map(section => ({ kind: 'section' as const, section })), title: 'Recent' }] : []
    }

    const botHits = bots.filter(bot => has(bot.display_name, needle) || has(bot.name, needle) || has(bot.title, needle))
    const roomHits = rooms.filter(room => has(room.name, needle))
    const sectionHits = sections.filter(section => has(section.title, needle) || has(section.preview, needle)).slice(0, MAX_SECTIONS)

    return [
      { data: botHits.map(bot => ({ bot, kind: 'bot' as const })), title: 'Bots' },
      { data: roomHits.map(room => ({ kind: 'room' as const, room })), title: 'Rooms' },
      { data: sectionHits.map(section => ({ kind: 'section' as const, section })), title: 'Sections' }
    ].filter(group => group.data.length)
  }, [bots, needle, rooms, sections])

  const go = (item: Item) => {
    closeSheet()

    if (item.kind === 'bot') {
      void openBot(item.bot.name)
    } else if (item.kind === 'room') {
      router.push({ params: { id: item.room.id }, pathname: '/room/[id]' })
    } else {
      openSection(item.section.id)
    }
  }

  const mark: TextStyle = { color: colors.text, fontWeight: '700' }

  return (
    <>
      <Stack.Screen options={{ headerShadowVisible: false, headerShown: true, headerTransparent: true, title: 'Search' }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button accessibilityLabel="Close" icon="xmark" onPress={closeSheet} />
      </Stack.Toolbar>
      <Stack.SearchBar
        autoCapitalize="none"
        autoFocus
        hideWhenScrolling={false}
        onCancelButtonPress={closeSheet}
        onChangeText={event => setQuery(event.nativeEvent.text)}
        placeholder="Bots, rooms and sections"
        placement="stacked"
        ref={bar}
      />

      <SectionList
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={s.list}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={item => (item.kind === 'bot' ? `b:${item.bot.name}` : item.kind === 'room' ? `r:${item.room.id}` : `s:${item.section.id}`)}
        ListEmptyComponent={
          needle ? (
            <View style={s.empty} testID="search-empty">
              <Text style={s.emptyTitle}>No results for “{query.trim()}”</Text>
              <Text style={s.emptyLead}>Search looks at bot names and labels, room names, and section titles and previews.</Text>
            </View>
          ) : (
            <View style={s.empty}>
              <Text style={s.emptyLead}>Your recent sections show up here.</Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          if (item.kind === 'bot') {
            return (
              <Pressable
                accessibilityLabel={item.bot.display_name}
                accessibilityRole="button"
                onPress={() => go(item)}
                style={({ pressed }) => [s.row, pressed && s.pressed]}
                testID={`search-bot-${item.bot.name}`}
              >
                <BotFace bot={item.bot} size={FACE} status={item.bot.status} />
                <View style={s.body}>
                  <Highlight mark={mark} needle={needle} style={s.title} text={item.bot.display_name} />
                  {item.bot.title ? <Highlight mark={mark} needle={needle} style={s.sub} text={item.bot.title} /> : null}
                </View>
              </Pressable>
            )
          }

          if (item.kind === 'room') {
            const count = item.room.members.filter(member => member.member_kind === 'bot' && !member.left_at).length

            return (
              <Pressable
                accessibilityLabel={item.room.name}
                accessibilityRole="button"
                onPress={() => go(item)}
                style={({ pressed }) => [s.row, pressed && s.pressed]}
                testID={`search-room-${item.room.id}`}
              >
                <RoomCluster bots={byName} room={item.room} size={FACE} />
                <View style={s.body}>
                  <Highlight mark={mark} needle={needle} style={s.title} text={item.room.name} />
                  <Text style={s.sub}>
                    Room · {count === 1 ? '1 bot' : `${count} bots`}
                    {item.room.archived_at ? ' · Archived' : ''}
                  </Text>
                </View>
              </Pressable>
            )
          }

          const { section } = item
          const bot = byName[section.bot]

          return (
            <Pressable
              accessibilityLabel={`${section.title}, ${bot?.display_name ?? section.bot}`}
              accessibilityRole="button"
              onPress={() => go(item)}
              style={({ pressed }) => [s.row, pressed && s.pressed]}
              testID={`search-section-${section.id}`}
            >
              <BotFace bot={bot} name={section.bot} size={FACE} />
              <View style={s.body}>
                <View style={s.line}>
                  <Highlight mark={mark} needle={needle} style={[s.title, s.grow]} text={section.title || 'New section'} />
                  <Text style={s.time}>{rowTime(section.updated_at)}</Text>
                </View>
                <Highlight
                  mark={mark}
                  needle={needle}
                  style={s.sub}
                  text={`${bot?.display_name ?? section.bot}${section.archived_at ? ' · Archived' : ''}${section.preview ? ` · ${around(section.preview, needle)}` : ''}`}
                />
              </View>
            </Pressable>
          )
        }}
        renderSectionHeader={({ section }) => <Text style={s.header}>{section.title}</Text>}
        sections={groups}
        stickySectionHeadersEnabled={false}
        testID="search-results"
      />
    </>
  )
}

/** Text with every case-insensitive match of `needle` in bold. */
function Highlight({ mark, needle, style, text }: { mark: TextStyle; needle: string; style: TextStyle | TextStyle[]; text: string }) {
  if (!needle) {
    return (
      <Text numberOfLines={1} style={style}>
        {text}
      </Text>
    )
  }

  const parts: { hit: boolean; text: string }[] = []
  const lower = text.toLowerCase()
  let from = 0

  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) {
      parts.push({ hit: false, text: text.slice(from, at) })
    }

    parts.push({ hit: true, text: text.slice(at, at + needle.length) })
    from = at + needle.length
  }

  if (from < text.length) {
    parts.push({ hit: false, text: text.slice(from) })
  }

  return (
    <Text numberOfLines={1} style={style}>
      {parts.map((part, index) =>
        part.hit ? (
          <Text key={index} style={mark}>
            {part.text}
          </Text>
        ) : (
          part.text
        )
      )}
    </Text>
  )
}

const styles = (colors: Palette) =>
  StyleSheet.create({
    body: { flex: 1, gap: 2, minWidth: 0 },
    empty: { alignItems: 'center', gap: 8, paddingHorizontal: 40, paddingTop: 80 },
    emptyLead: { color: colors.textMuted, fontSize: 15, lineHeight: 20, textAlign: 'center' },
    emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '600', textAlign: 'center' },
    grow: { flex: 1 },
    header: { color: colors.textMuted, fontSize: 13, fontWeight: '500', paddingBottom: 6, paddingHorizontal: 20, paddingTop: 18 },
    line: { alignItems: 'baseline', flexDirection: 'row', gap: 8 },
    list: { paddingBottom: 40 },
    pressed: { backgroundColor: colors.surface },
    row: { alignItems: 'center', flexDirection: 'row', gap: 14, minHeight: 64, paddingHorizontal: 20, paddingVertical: 8 },
    sub: { color: colors.textMuted, fontSize: 15, lineHeight: 20 },
    time: { color: colors.textFaint, fontSize: 14 },
    title: { color: colors.text, fontSize: 17, fontWeight: '500', lineHeight: 22 }
  })
