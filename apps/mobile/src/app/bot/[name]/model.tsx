import { useEffect, useState } from 'react'

import { formatContext, type ModelChoice, ModelPicker, useModels } from '../../../components/bot/model-picker'
import { BotPage } from '../../../components/bot/page'
import { Group, Row } from '../../../components/list'
import type { Bot, BotUpdatePatch } from '../../../lib/types'

export default function Model() {
  return (
    <BotPage lead="Which provider and model this bot thinks with. Keys live in Settings, Providers." title="Model">
      {({ bot, quietly }) => <Choose bot={bot} save={quietly} />}
    </BotPage>
  )
}

function Choose({ bot, save }: { bot: Bot; save: (patch: BotUpdatePatch) => void }) {
  // A provider switch waits here until a model is picked, so the bot never runs on half a choice.
  const [choice, setChoice] = useState<ModelChoice>({ model: bot.model ?? '', provider: bot.provider ?? '' })
  const models = useModels(choice.provider || null)

  useEffect(() => {
    setChoice({ model: bot.model ?? '', provider: bot.provider ?? '' })
  }, [bot.model, bot.provider])

  const current = [...models.curated, ...models.all].find(item => item.id === choice.model)
  const context = formatContext(current?.context)

  return (
    <>
      {current && (context || current.input_cost || current.output_cost) ? (
        <Group label="About this model">
          {context ? <Row title="Context" value={`${current.context!.toLocaleString()} tokens`} /> : null}
          {current.input_cost ? <Row title="Input" value={`${current.input_cost} per 1M tokens`} /> : null}
          {current.output_cost ? <Row title="Output" value={`${current.output_cost} per 1M tokens`} /> : null}
        </Group>
      ) : null}
      <ModelPicker
        onChange={next => {
          setChoice(next)

          if (next.model) {
            save({ model: next.model, provider: next.provider })
          }
        }}
        value={choice}
      />
    </>
  )
}
