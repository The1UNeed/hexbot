import { Ionicons } from '@expo/vector-icons'
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import type { Bot, Rpc } from '../core/types'
import { Text, useTheme } from '../ui'

import { ConnectCard } from './ConnectCard'
import { ModelPill, type Models, type ModelValue } from './ModelMenu'

/** A bot whose provider lost its key or sign-in: nothing it says can reach a model. */
export function providerGone(bot: Bot | null | undefined): bot is Bot {
  return Boolean(bot?.provider) && bot?.provider_connected === false
}

/**
 * Sits above the composer while the bot's provider is gone, before the user
 * types: pick a connected provider's model and the bot moves there from its
 * next message. Keys live in Settings, Providers.
 */
export function ProviderGoneCard({ bot, models, rpc }: { bot: Bot; models: Models; rpc: Rpc }) {
  const theme = useTheme()
  const [label, setLabel] = useState(bot.provider ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The provider's name as Settings shows it; its id until the list arrives.
  useEffect(() => {
    let live = true
    rpc<{ providers: { id: string; label: string }[] }>('hexbot.providers.list')
      .then(({ providers }) => {
        if (live) setLabel(providers.find(p => p.id === bot.provider)?.label ?? bot.provider ?? '')
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [bot.provider, rpc])

  // The menu lists connected providers only; the daemon's change event removes the card.
  const choose = async (next: Partial<ModelValue>) => {
    if (!next.provider || !next.model) return
    setBusy(true)
    setError(null)
    try {
      await rpc('hexbot.bots.update', { name: bot.name, provider: next.provider, model: next.model })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConnectCard
      accessibilityLabel="Choose a model"
      icon={<Ionicons color={theme.accent} name="sparkles-outline" size={20} />}
      subtitle={`Choose a model for ${bot.display_name} to continue`}
      testID="provider-gone"
      title={`${label} is no longer connected`}
    >
      <View style={styles.body}>
        <ModelPill
          disabled={busy}
          models={models}
          onChange={next => void choose(next)}
          rpc={rpc}
          testID="provider-gone-model"
          value={{ model: '', provider: '', reasoning: bot.reasoning_effort ?? '' }}
        />
        {error ? (
          <Text tone="danger" variant="footnote">
            {error}
          </Text>
        ) : null}
      </View>
    </ConnectCard>
  )
}

const styles = StyleSheet.create({
  body: { alignItems: 'flex-start', gap: 8, paddingTop: 10 }
})
