import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Menu } from '../../components/ui/menu'
import { Textarea } from '../../components/ui/textarea'
import { BOT_TEMPLATES } from '../../lib/bot-templates'
import { cn } from '../../lib/cn'
import type { Bot } from '../../lib/types'

import { cardClass, Heading, type SaveBot } from './shared'

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
      !window.confirm(`Replace the soul with the ${template.title} template?`)
    ) {
      return
    }

    setPersona(template.persona)
    void onSave({ persona: template.persona })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Heading description="Who this bot is: how it behaves and speaks. The bot may edit this too, and says so when it does.">
        Soul
      </Heading>
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[length:var(--text-meta)] text-muted">
          {wordCount(persona)} words · saved when you leave the field
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
      <div className={cn(cardClass, 'flex min-h-0 flex-1 overflow-hidden')}>
        <Textarea
          aria-label="Soul"
          className="min-h-[24rem] flex-1 rounded-none bg-transparent px-4 py-3 hover:bg-transparent focus-visible:bg-transparent"
          onBlur={() => {
            if (persona !== bot.persona) {
              void onSave({ persona })
            }
          }}
          onChange={event => setPersona(event.target.value)}
          value={persona}
        />
      </div>
    </div>
  )
}
