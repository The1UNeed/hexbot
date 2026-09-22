import { Archive, Trash2, Undo2 } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import type { Section } from '../../lib/types'
import { useSections, useSectionsForBot } from '../../stores/sections'
import { relativeTime } from '../roster'

import { cardClass, Heading } from './shared'

export function SectionsTab({ botName }: { botName: string }) {
  const sections = useSectionsForBot(botName)
  const { archive, refresh, remove, unarchive } = useSections()
  useEffect(() => {
    void refresh({ bot: botName, include_archived: true })
  }, [botName, refresh])
  const active = sections.filter(section => !section.archived_at)
  const archived = sections.filter(section => section.archived_at)

  const row = (section: Section) => (
    <li className="flex items-center gap-2 py-2 pr-2 pl-3" key={section.id}>
      <span className="min-w-0 flex-1 truncate">{section.title}</span>
      <span className="text-[length:var(--text-meta)] text-muted">
        {relativeTime(section.updated_at)}
      </span>
      {section.archived_at ? (
        <Button
          aria-label={`Unarchive ${section.title}`}
          icon={<Undo2 size={14} />}
          onClick={() => void unarchive(section.id)}
          size="sm"
          variant="ghost"
        />
      ) : (
        <Button
          aria-label={`Archive ${section.title}`}
          icon={<Archive size={14} />}
          onClick={() => void archive(section.id)}
          size="sm"
          variant="ghost"
        />
      )}
      <Button
        aria-label={`Delete ${section.title}`}
        icon={<Trash2 size={14} />}
        onClick={() => {
          if (window.confirm(`Delete “${section.title}”? Its history goes with it.`)) {
            void remove(section.id)
          }
        }}
        size="sm"
        variant="ghost"
      />
    </li>
  )

  return (
    <div>
      <Heading description="Every conversation with this bot. Archiving keeps its history; deleting removes it.">
        Sections
      </Heading>
      {active.length ? (
        <ul className={cn(cardClass, 'divide-y divide-border')}>{active.map(row)}</ul>
      ) : (
        <p className="text-muted">No open sections.</p>
      )}
      {archived.length ? (
        <div className="mt-5">
          <p className="mb-2 pl-0.5 text-[length:var(--text-secondary)] text-muted">Archived</p>
          <ul className={cn(cardClass, 'divide-y divide-border')}>{archived.map(row)}</ul>
        </div>
      ) : null}
    </div>
  )
}
