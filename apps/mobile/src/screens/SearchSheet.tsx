import { Ionicons } from '@expo/vector-icons'
import { useDeferredValue, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import {
  MESSAGE_LIMIT,
  search,
  type SearchDocument,
  type SearchHit,
  type SearchResults
} from '../core/search'
import type { SearchEntry } from '../../../web/src/lib/search'
import {
  EmptyState,
  formatListTime,
  Group,
  ModalSheet,
  Row,
  SearchField,
  Text,
  useTheme
} from '../ui'

export interface SearchSheetProps {
  visible: boolean
  onClose: () => void
  /** "your chat with Muse" or the room's name, for the title and the empty state. */
  name: string
  entries: SearchEntry[]
  /** A bot's soul and memory; rooms have none. */
  documents?: SearchDocument[]
  /** Shows a found message in the transcript. */
  onMessage: (id: string) => void
  onVisual: (id: string) => void
  onDocument?: (kind: SearchDocument['kind']) => void
}

const GROUPS: { icon: keyof typeof Ionicons.glyphMap; key: keyof SearchResults; label: string }[] =
  [
    { icon: 'chatbubble-outline', key: 'messages', label: 'Messages' },
    { icon: 'document-outline', key: 'files', label: 'Files' },
    { icon: 'easel-outline', key: 'visuals', label: 'Visuals' },
    { icon: 'finger-print-outline', key: 'documents', label: 'Soul and memory' }
  ]

/**
 * Search in one conversation, as the app's panel does: messages, files,
 * visuals, and in a bot's chat its soul and memory. A message closes the
 * sheet and shows itself in the transcript.
 */
export function SearchSheet({
  documents,
  entries,
  name,
  onClose,
  onDocument,
  onMessage,
  onVisual,
  visible
}: SearchSheetProps) {
  const theme = useTheme()
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const results = useMemo(
    () => search(entries, deferred, documents),
    [documents, deferred, entries]
  )

  const pick = (hit: SearchHit) => {
    const target = hit.target
    onClose()
    if (target.kind === 'entry') onMessage(target.id)
    else if (target.kind === 'visual') onVisual(target.visual.toolId)
    else onDocument?.(target.document)
  }

  return (
    <ModalSheet
      header={
        <View style={styles.field}>
          <SearchField onChangeText={setQuery} testID="search-field" value={query} />
        </View>
      }
      onClose={onClose}
      testID="search-sheet"
      title="Search"
      visible={visible}
    >
      {!deferred.trim() ? (
        <EmptyState
          message={`Messages, files and visuals in ${name}${documents ? ', and its soul and memory' : ''}.`}
          testID="search-empty"
          title="Search"
        />
      ) : !results.total ? (
        <EmptyState testID="search-none" title={`Nothing matches “${deferred.trim()}”.`} />
      ) : (
        GROUPS.map(group => {
          const hits = results[group.key]
          if (!Array.isArray(hits) || !hits.length) return null
          return (
            <Group
              footer={
                group.key === 'messages' && hits.length === MESSAGE_LIMIT
                  ? `Showing the latest ${MESSAGE_LIMIT}. Add a word to narrow it.`
                  : undefined
              }
              key={group.key}
              separatorInset={52}
              title={group.label}
            >
              {hits.map(hit => (
                <Row
                  key={hit.key}
                  leading={<Ionicons color={theme.muted} name={group.icon} size={20} />}
                  meta={formatListTime(hit.at)}
                  onPress={() => pick(hit)}
                  subtitle={hit.snippet || null}
                  subtitleLines={2}
                  testID={`search-hit-${hit.key}`}
                  title={hit.title}
                />
              ))}
            </Group>
          )
        })
      )}
      {results.total ? (
        <Text align="center" style={styles.count} tone="muted" variant="footnote">
          {results.total === 1 ? '1 result' : `${results.total} results`}
        </Text>
      ) : null}
    </ModalSheet>
  )
}

const styles = StyleSheet.create({
  count: { marginTop: 8 },
  field: { paddingBottom: 8, paddingHorizontal: 16 }
})
