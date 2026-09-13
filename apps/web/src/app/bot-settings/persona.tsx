import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Menu } from '../../components/ui/menu'
import { Textarea } from '../../components/ui/textarea'
import { BOT_TEMPLATES } from '../../lib/bot-templates'
import type { Bot } from '../../lib/types'

import { Heading, type SaveBot } from './shared'

const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0)

export function PersonaTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const [persona, setPersona] = useState(bot.persona)
  useEffect(() => setPersona(bot.persona), [bot.persona])

  const applyTemplate = (id: string) => {
    const template = BOT_TEMPLATES.find(item => item.id === id)

    if (!template) {
      return
    }

    if (
      persona.trim() &&
      persona !== template.persona &&
      !window.confirm(`Replace the persona with the ${template.title} template?`)
    ) {
      return
    }

    setPersona(template.persona)
    void onSave({ persona: template.persona })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Heading description="How this bot behaves and speaks. Saved when you leave the field.">
        Persona
      </Heading>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[length:var(--text-secondary)] text-muted">
          {wordCount(persona)} words
        </span>
        <Menu
          items={BOT_TEMPLATES.map(item => ({
            label: item.title,
            onSelect: () => applyTemplate(item.id)
          }))}
          trigger={
            <Button icon={<ChevronDown size={14} />} size="sm" variant="ghost">
              Use a template
            </Button>
          }
        />
      </div>
      <Textarea
        aria-label="Persona"
        className="min-h-[24rem] flex-1"
        onBlur={() => {
          if (persona !== bot.persona) {
            void onSave({ persona })
          }
        }}
        onChange={event => setPersona(event.target.value)}
        value={persona}
      />
    </div>
  )
}
