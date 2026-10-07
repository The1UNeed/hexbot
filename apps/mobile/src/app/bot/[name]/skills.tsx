import { useEffect, useState } from 'react'
import { ActivityIndicator } from 'react-native'

import { BotPage, Note } from '../../../components/bot/page'
import { errorText } from '../../../components/bot/use-bot'
import { Group, SwitchRow } from '../../../components/list'
import { skillsList } from '../../../lib/api'
import type { Bot, BotUpdatePatch, SkillInfo } from '../../../lib/types'
import { useTheme } from '../../../theme'

const categoryTitle = (value: string) => {
  const words = value
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b(ai|mcp|api)\b/gi, word => word.toUpperCase())

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other'
}

export default function Skills() {
  return (
    <BotPage lead="Instructions this bot can follow for specific jobs. Installed skills are on unless you turn them off." title="Skills">
      {({ bot, save }) => <SkillList bot={bot} save={save} />}
    </BotPage>
  )
}

function SkillList({ bot, save }: { bot: Bot; save: (patch: BotUpdatePatch) => Promise<unknown> }) {
  const { colors } = useTheme()
  const [skills, setSkills] = useState<null | SkillInfo[]>(null)
  const [error, setError] = useState<null | string>(null)
  // `bot.skills` is a fresh array on every refresh; key on its contents.
  const chosenKey = bot.skills.join(' ')

  useEffect(() => {
    void skillsList(bot.name)
      .then(result => setSkills(result.skills))
      .catch(caught => setError(errorText(caught)))
  }, [bot.name, chosenKey])

  if (error && !skills) {
    return <Note danger text={error} />
  }

  if (!skills) {
    return <ActivityIndicator color={colors.textMuted} style={{ paddingVertical: 32 }} />
  }

  if (!skills.length) {
    return <Note text="No skills are installed for this bot." />
  }

  const toggle = (name: string, on: boolean) => {
    const before = skills
    const next = skills.map(item => (item.name === name ? { ...item, enabled: on } : item))

    setSkills(next)
    setError(null)
    void save({ skills: next.filter(item => item.enabled).map(item => item.name) }).catch(caught => {
      setSkills(before)
      setError(errorText(caught))
    })
  }

  const categories = [...new Set(skills.map(item => item.category || 'other'))].sort()

  return (
    <>
      {error ? <Note danger text={error} /> : null}
      {categories.map(category => (
        <Group key={category} label={categoryTitle(category)}>
          {skills
            .filter(item => (item.category || 'other') === category)
            .map(item => (
              <SwitchRow
                key={item.name}
                onValueChange={on => toggle(item.name, on)}
                subtitle={item.description}
                testID={`skill-${item.name}`}
                title={item.name}
                value={item.enabled}
              />
            ))}
        </Group>
      ))}
    </>
  )
}
