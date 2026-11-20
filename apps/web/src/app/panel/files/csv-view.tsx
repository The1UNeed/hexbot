import { useEffect, useMemo, useRef, useState } from 'react'

import { parseDelimited, serializeDelimited } from '../../../lib/delimited'

import { statusText, useAutosave } from './autosave'
import type { CommentTarget } from './comment-layer'
import { downloadBlob, downloadEntry, FileToolbar, ViewSwitch } from './file-toolbar'
import { SheetGrid } from './sheet-grid'

export type SheetMode = 'table' | 'text'

/**
 * A CSV or TSV file as a table: cells edited in place, rows and columns
 * added or removed, saved as the same kind of file a moment later. Text
 * shows the file as it is.
 */
export function CsvView({
  delimiter,
  editable,
  flushRef,
  name,
  onComment,
  onMode,
  onSave,
  text
}: {
  delimiter: string
  editable: boolean
  flushRef: { current: (() => Promise<boolean>) | null }
  name: string
  onComment?: (target: CommentTarget, open: boolean) => void
  onMode: (mode: SheetMode) => void
  onSave: (text: string) => Promise<void>
  /** The file's text; a new one (the bot's edit) is shown unless an edit waits to save. */
  text: string
}) {
  const [rows, setRows] = useState(() => parseDelimited(text, delimiter))
  const latest = useRef(rows)
  latest.current = rows
  const written = useRef(text)

  const save = useAutosave(async () => {
    const next = serializeDelimited(latest.current, delimiter, written.current)
    await onSave(next)
    written.current = next
  }, flushRef)

  useEffect(() => {
    if (text !== written.current && !save.dirty()) {
      written.current = text
      setRows(parseDelimited(text, delimiter))
    }
    // A new text from the file is the only reason to read it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const columns = useMemo(() => rows.reduce((most, row) => Math.max(most, row.length), 0), [rows])

  const update = (next: string[][]) => {
    setRows(next)
    latest.current = next
    save.schedule()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileToolbar
        menu={[
          downloadEntry(() =>
            downloadBlob(
              name,
              new Blob([serializeDelimited(rows, delimiter, written.current)], { type: 'text/csv' })
            )
          )
        ]}
        status={statusText(save.status)}
      >
        <ViewSwitch
          onChange={mode => {
            // The text view opens on what was saved.
            void save.flush().then(ok => ok && onMode(mode))
          }}
          options={[
            { label: 'Table', value: 'table' },
            { label: 'Text', value: 'text' }
          ]}
          value="table"
        />
      </FileToolbar>
      {save.error ? (
        <p
          className="mx-3 mb-2 rounded-[12px] bg-danger/10 px-3 py-2 text-[length:var(--text-meta)] text-danger"
          role="alert"
        >
          {save.error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <SheetGrid
          columns={Math.max(columns, 1)}
          editable={editable}
          headerRow
          onChange={changes => {
            const next = rows.map(row => [...row])

            for (const { cell, value } of changes) {
              while (next.length <= cell.row) {
                next.push([])
              }

              const row = next[cell.row]!

              while (row.length <= cell.col) {
                row.push('')
              }

              row[cell.col] = value
            }

            update(next)
          }}
          onComment={onComment}
          onDeleteColumns={(from, to) =>
            update(rows.map(row => row.filter((_, index) => index < from || index > to)))
          }
          onDeleteRows={(from, to) => update(rows.filter((_, index) => index < from || index > to))}
          onInsertColumn={at =>
            update(
              rows.map(row =>
                row.length >= at ? [...row.slice(0, at), '', ...row.slice(at)] : row
              )
            )
          }
          onInsertRow={at =>
            update([
              ...rows.slice(0, at),
              Array.from({ length: columns }, () => ''),
              ...rows.slice(at)
            ])
          }
          rows={rows}
        />
      </div>
    </div>
  )
}
