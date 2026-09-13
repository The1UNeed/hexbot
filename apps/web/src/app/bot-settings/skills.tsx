import { useEffect, useState } from 'react'

import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { skillsList } from '../../lib/api'
import type { Bot, SkillInfo } from '../../lib/types'

import { errorText, Group, Heading, Row, type SaveBot } from './shared'

export function SkillsTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // `bot.skills` is a fresh array on every bots refresh; key on its contents.
  const chosenKey = bot.skills.join(' ')
  useEffect(() => {
    void skillsList(bot.name)
      .then(result => setSkills(result.skills))
      .catch(cause => setError(errorText(cause)))
  }, [bot.name, chosenKey])

  const toggle = (name: string, checked: boolean) => {
    if (!skills) {
      return
    }

    const chosen = skills.filter(item => (item.name === name ? checked : item.enabled))
    setSkills(skills.map(item => (item.name === name ? { ...item, enabled: checked } : item)))
    void onSave({ skills: chosen.map(item => item.name) })
  }

  const categories = [...new Set((skills ?? []).map(item => item.category || 'Other'))].sort()

  return (
    <div>
      <Heading description="Instructions this bot can follow for specific jobs. Installed skills are on unless you turn them off.">
        Skills
      </Heading>
      {error ? (
        <p className="text-danger" role="alert">
          {error}
        </p>
      ) : skills === null ? (
        <SkeletonLines label="Loading skills" />
      ) : skills.length === 0 ? (
        <p className="text-muted">No skills installed for this bot.</p>
      ) : (
        <div className="space-y-5">
          {categories.map(category => (
            <Group key={category} title={category}>
              {skills
                .filter(item => (item.category || 'Other') === category)
                .map(item => (
                  <Row
                    control={
                      <Switch
                        aria-label={item.name}
                        checked={item.enabled}
                        onCheckedChange={checked => toggle(item.name, checked)}
                      />
                    }
                    description={item.description}
                    key={item.name}
                    title={item.name}
                  />
                ))}
            </Group>
          ))}
        </div>
      )}
    </div>
  )
}
