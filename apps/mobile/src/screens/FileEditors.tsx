import { memo, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import {
  columnName,
  linesOf,
  type Range,
  rangeBounds,
  rangeName
} from '../../../web/src/lib/file-comments'
import { addRow, rangeQuote, rowsOf, setCell, tableText } from '../core/file-edit'
import { TABLE_CELLS, TABLE_COLUMNS, TABLE_ROWS } from '../core/files'
import { MarkdownText } from '../MarkdownText'
import { Button, mono, Segmented, Text, useTheme, withAlpha } from '../ui'

/** What the card asks of the editor it shows: write the edit back, if there is one. */
export interface EditorHandle {
  /** True once nothing is left to save; false when the save was refused. */
  save: () => Promise<boolean>
}

/** Writes the file; false when it was refused, which the card explains. */
export type WriteFile = (contents: { text: string } | { data_url: string }) => Promise<boolean>

/** A comment about to be written: where in the file, and the words or values it is about. */
export interface CommentAsk {
  where: string
  quote?: string
  area?: { x: number; y: number; w: number; h: number }
}

export interface EditorProps {
  handle: RefObject<EditorHandle | null>
  onDirty: (dirty: boolean) => void
  /** Absent for a file only this phone holds, which can't be saved. */
  write?: WriteFile
  /** Absent where the chat takes no messages. */
  onComment?: (ask: CommentAsk) => void
}

/**
 * The note for a comment, under what it is about. It sits at the bottom of
 * the card, above the keyboard; Add puts it above the chat's composer.
 */
export function CommentBar({
  ask,
  botName,
  onAdd,
  onCancel
}: {
  ask: CommentAsk
  botName: string
  onAdd: (note: string) => void
  onCancel: () => void
}) {
  const theme = useTheme()
  const [note, setNote] = useState('')
  const quote = ask.quote?.replace(/\s+/g, ' ').trim()
  return (
    <View
      style={[styles.bar, { backgroundColor: theme.surface, borderTopColor: theme.hairline }]}
      testID="file-comment-bar"
    >
      <Text numberOfLines={2} tone="muted" variant="footnote">
        {ask.where}
        {quote ? `: “${quote}”` : ''}
      </Text>
      <TextInput
        accessibilityLabel={`Comment for ${botName}`}
        autoFocus
        multiline
        onChangeText={setNote}
        placeholder={`Comment for ${botName}`}
        placeholderTextColor={theme.faint}
        selectionColor={theme.accent}
        style={[styles.note, { backgroundColor: theme.fill, color: theme.text }]}
        testID="file-comment-input"
        value={note}
      />
      <View style={styles.barActions}>
        <Button
          label="Cancel"
          onPress={onCancel}
          size="small"
          testID="file-comment-cancel"
          variant="plain"
        />
        <Button
          disabled={!note.trim()}
          label="Add comment"
          onPress={() => onAdd(note.trim())}
          size="small"
          testID="file-comment-add"
        />
      </View>
    </View>
  )
}

/** Characters the phone edits at most; a longer file shows its start. */
export const EDIT_CHARS = 60_000

/**
 * A text file in a field: typed into, and saved with Save or when the card
 * closes. Selecting words offers Comment. Markdown shows formatted until Edit.
 */
export function TextEditor({
  handle,
  markdown,
  onComment,
  onDirty,
  text,
  write
}: EditorProps & { text: string; markdown: boolean }) {
  const theme = useTheme()
  const [draft, setDraft] = useState(text)
  const [mode, setMode] = useState<'edit' | 'formatted'>(markdown ? 'formatted' : 'edit')
  const [selection, setSelection] = useState({ end: 0, start: 0 })
  const saved = useRef(text)
  const latest = useRef(draft)
  latest.current = draft

  handle.current = {
    save: async () => {
      const next = latest.current
      if (next === saved.current) return true
      if (!write || !(await write({ text: next }))) return false
      saved.current = next
      onDirty(latest.current !== next)
      return true
    }
  }

  const change = (next: string) => {
    setDraft(next)
    onDirty(next !== saved.current)
  }

  const picked = selection.end > selection.start
  return (
    <View style={styles.fill}>
      {markdown ? (
        <View style={styles.switch}>
          <Segmented
            onChange={setMode}
            options={[
              { key: 'formatted', label: 'Formatted' },
              { key: 'edit', label: 'Edit' }
            ]}
            selected={mode}
            testID="file-markdown-mode"
          />
        </View>
      ) : null}
      {mode === 'formatted' ? (
        <ScrollView contentContainerStyle={styles.formatted}>
          <View style={[styles.page, { backgroundColor: theme.surface }]} testID="file-markdown">
            <MarkdownText text={draft} />
          </View>
        </ScrollView>
      ) : (
        <TextInput
          accessibilityLabel="File text"
          autoCapitalize="none"
          autoCorrect={markdown}
          editable={!!write}
          multiline
          onChangeText={change}
          onSelectionChange={event => setSelection(event.nativeEvent.selection)}
          scrollEnabled
          selectionColor={theme.accent}
          spellCheck={markdown}
          style={[
            styles.field,
            { backgroundColor: theme.surface, color: theme.text },
            !markdown && styles.code
          ]}
          testID="file-text-input"
          textAlignVertical="top"
          value={draft}
        />
      )}
      {mode === 'edit' && picked && onComment ? (
        <View style={[styles.selectionBar, { borderTopColor: theme.hairline }]}>
          <Button
            icon="chatbox-ellipses-outline"
            label={`Comment on ${linesOf(draft, selection.start, selection.end)}`}
            onPress={() =>
              onComment({
                quote: draft.slice(selection.start, selection.end),
                where: linesOf(draft, selection.start, selection.end)
              })
            }
            size="small"
            testID="file-comment-selection"
            variant="secondary"
          />
        </View>
      ) : null}
    </View>
  )
}

/** Characters' width in a cell, as a column's width; long values wrap inside it. */
const columnWidth = (cells: string[]) =>
  Math.round(Math.min(220, Math.max(56, Math.max(...cells.map(c => c.length)) * 7.5 + 24)))

const NUMBER_WIDTH = 40

/**
 * A CSV or TSV file as a table. A tap picks a cell, which the field under
 * the table edits; a long press on another cell picks the range between, to
 * comment on. Add row adds one at the end. Every row is saved, also those the
 * phone does not draw.
 */
export function TableEditor({
  handle,
  name,
  onComment,
  onDirty,
  text,
  write
}: EditorProps & { text: string; name: string }) {
  const theme = useTheme()
  const [rows, setRows] = useState(() => rowsOf(text, name))
  const [range, setRange] = useState<Range | null>(null)
  const [cell, setCellDraft] = useState('')
  const written = useRef(text)
  const latest = useRef({ cell, range, rows })
  latest.current = { cell, range, rows }

  /** The table with the field's value in its cell. */
  const withCell = () => {
    const { cell: value, range: picked, rows: current } = latest.current
    if (!picked || !write) return current
    const { col, row } = picked.focus
    return (current[row]?.[col] ?? '') === value ? current : setCell(current, row, col, value)
  }

  const commitCell = () => {
    const next = withCell()
    if (next !== latest.current.rows) {
      latest.current.rows = next
      setRows(next)
      onDirty(true)
    }
    return next
  }

  handle.current = {
    save: async () => {
      const next = tableText(commitCell(), name, written.current)
      if (next === written.current) {
        // Typed back to what it was: nothing to write.
        onDirty(false)
        return true
      }
      if (!write || !(await write({ text: next }))) return false
      written.current = next
      onDirty(false)
      return true
    }
  }

  const columns = rows.reduce((most, row) => Math.max(most, row.length), 0)
  const shownColumns = Math.max(1, Math.min(columns, TABLE_COLUMNS))
  const shownRows = Math.min(rows.length, TABLE_ROWS, Math.floor(TABLE_CELLS / shownColumns))
  // Widths from the file as it opened, so a cell being typed into doesn't move its column.
  const widths = useMemo(
    () =>
      Array.from({ length: shownColumns }, (_, i) =>
        columnWidth(
          rowsOf(text, name)
            .slice(0, 200)
            .map(row => row[i] ?? '')
        )
      ),
    [name, shownColumns, text]
  )

  const pick = (row: number, col: number, extend: boolean) => {
    const current = commitCell()
    const next =
      extend && latest.current.range
        ? { anchor: latest.current.range.anchor, focus: { col, row } }
        : { anchor: { col, row }, focus: { col, row } }
    setRange(next)
    setCellDraft(current[row]?.[col] ?? '')
  }

  // A value being typed is an edit already: Save shows, and writes it in.
  const typeCell = (value: string) => {
    setCellDraft(value)
    const at = latest.current.range?.focus
    if (at && value !== (latest.current.rows[at.row]?.[at.col] ?? '')) onDirty(true)
  }

  const bounds = range ? rangeBounds(range) : null
  const single = !!bounds && bounds.left === bounds.right && bounds.top === bounds.bottom
  return (
    <View style={styles.fill}>
      <ScrollView contentContainerStyle={styles.tableScroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.table, { backgroundColor: theme.surface }]} testID="file-table">
          <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator>
            <View>
              <View style={[styles.row, { backgroundColor: theme.fill }]}>
                <View style={{ width: NUMBER_WIDTH }} />
                {widths.map((width, c) => (
                  <Text
                    align="center"
                    key={c}
                    style={[styles.letter, { width }]}
                    tone="faint"
                    variant="caption"
                  >
                    {columnName(c)}
                  </Text>
                ))}
              </View>
              {rows.slice(0, shownRows).map((row, r) => (
                <TableRow
                  cells={row}
                  key={r}
                  onPick={pick}
                  picked={
                    bounds && r >= bounds.top && r <= bounds.bottom
                      ? [bounds.left, bounds.right]
                      : null
                  }
                  r={r}
                  widths={widths}
                />
              ))}
            </View>
          </ScrollView>
        </View>
        {shownRows < rows.length || columns > TABLE_COLUMNS ? (
          <Text style={styles.more} tone="muted" variant="footnote">
            Showing {shownRows} of {rows.length} rows and {shownColumns} of {columns} columns.
            Saving keeps them all.
          </Text>
        ) : null}
        {write ? (
          <Button
            icon="add"
            label="Add row"
            onPress={() => {
              const next = addRow(commitCell())
              setRows(next)
              onDirty(true)
            }}
            size="small"
            style={styles.addRow}
            testID="file-table-add-row"
            variant="plain"
          />
        ) : null}
      </ScrollView>
      {range ? (
        <View
          style={[styles.bar, { backgroundColor: theme.surface, borderTopColor: theme.hairline }]}
          testID="file-cell-bar"
        >
          <View style={styles.cellRow}>
            <Text style={styles.cellName} tone="muted" variant="subhead">
              {rangeName(range)}
            </Text>
            {single && write ? (
              <TextInput
                accessibilityLabel={`Edit ${rangeName(range)}`}
                onBlur={commitCell}
                onChangeText={typeCell}
                onSubmitEditing={commitCell}
                returnKeyType="done"
                selectionColor={theme.accent}
                style={[styles.cellField, { backgroundColor: theme.fill, color: theme.text }]}
                submitBehavior="blurAndSubmit"
                testID="file-cell-input"
                value={cell}
              />
            ) : (
              <Text style={styles.fill} tone="muted" variant="footnote">
                {single ? cell : 'Long-press a cell to pick the range up to it.'}
              </Text>
            )}
          </View>
          {onComment ? (
            <Button
              icon="chatbox-ellipses-outline"
              label={`Comment on ${rangeName(range)}`}
              onPress={() =>
                onComment({ quote: rangeQuote(commitCell(), range), where: rangeName(range) })
              }
              size="small"
              testID="file-comment-range"
              variant="secondary"
            />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const TableRow = memo(function TableRow({
  cells,
  onPick,
  picked,
  r,
  widths
}: {
  cells: string[]
  onPick: (row: number, col: number, extend: boolean) => void
  /** The picked columns in this row, first and last. */
  picked: [number, number] | null
  r: number
  widths: number[]
}) {
  const theme = useTheme()
  const pickRef = useRef(onPick)
  useEffect(() => {
    pickRef.current = onPick
  })
  return (
    <View
      style={[
        styles.row,
        { borderTopColor: theme.hairline, borderTopWidth: StyleSheet.hairlineWidth },
        r === 0 && { backgroundColor: theme.fill }
      ]}
    >
      <Text
        align="center"
        style={[styles.number, { width: NUMBER_WIDTH }]}
        tone="faint"
        variant="caption"
      >
        {r + 1}
      </Text>
      {widths.map((width, c) => {
        const on = !!picked && c >= picked[0] && c <= picked[1]
        return (
          <Pressable
            accessibilityLabel={`${columnName(c)}${r + 1}: ${cells[c] ?? ''}`}
            delayLongPress={350}
            key={c}
            onLongPress={() => pickRef.current(r, c, true)}
            onPress={() => pickRef.current(r, c, false)}
            style={[
              styles.cell,
              { width },
              on && { backgroundColor: withAlpha(theme.accent, 0.12), borderColor: theme.accent }
            ]}
            testID={`file-cell-${r}-${c}`}
          >
            <Text tone={r === 0 ? 'muted' : 'text'} variant={r === 0 ? 'caption' : 'footnote'}>
              {cells[c] ?? ''}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
})

const styles = StyleSheet.create({
  addRow: { alignSelf: 'flex-start', marginTop: 8 },
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  barActions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  cell: {
    borderColor: 'transparent',
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 8
  },
  cellField: { borderRadius: 10, flex: 1, fontSize: 16, minHeight: 40, paddingHorizontal: 12 },
  cellName: { minWidth: 44 },
  cellRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
  field: {
    borderRadius: 16,
    flex: 1,
    fontSize: 16,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 14
  },
  fill: { flex: 1 },
  formatted: { paddingBottom: 24, paddingHorizontal: 12 },
  letter: { paddingVertical: 4 },
  more: { marginTop: 10, paddingHorizontal: 4 },
  note: {
    borderRadius: 12,
    fontSize: 16,
    maxHeight: 120,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  number: { alignSelf: 'center' },
  page: { borderRadius: 16, padding: 16 },
  row: { flexDirection: 'row' },
  selectionBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 8
  },
  switch: { paddingBottom: 10, paddingHorizontal: 12 },
  table: { alignSelf: 'flex-start', borderRadius: 16, maxWidth: '100%', overflow: 'hidden' },
  tableScroll: { paddingBottom: 16, paddingHorizontal: 12 }
})
