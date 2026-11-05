import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { pluginFormIcon } from '../../../web/src/lib/plugin-icons'
import type { PluginForm } from '../../../web/src/lib/types'
import { Button, mono, radius, Text, useTheme } from '../ui'
import { PluginIcon } from '../ui/PluginIcon'

import { CardField, CardStatus, ConnectCard, cardStyles } from './ConnectCard'
import type { ApprovalChoice, ApprovalRequestView, CardAnswer } from './types'

const VERBS: Record<PluginForm['action'], string> = {
  enable: 'Turn on',
  install: 'Install',
  setup: 'Connect'
}

const DONE: Record<PluginForm['action'], string> = {
  enable: 'On',
  install: 'Installed',
  setup: 'Saved'
}

/**
 * The card a bot shows with `hexbot_plugins` to install a plugin, turn one
 * on, or set one up. Setup folds behind Connect, like a sign-in; the keys
 * typed go to the daemon with the answer, which saves them as Settings,
 * Plugins does. The bot never sees them.
 */
export function PluginCard({
  form,
  joined,
  onAnswer,
  request
}: {
  form: PluginForm
  joined?: boolean
  onAnswer: (
    requestId: string,
    choice: ApprovalChoice,
    answer?: CardAnswer
  ) => Promise<unknown> | void
  request: ApprovalRequestView
}) {
  const theme = useTheme()
  const [open, setOpen] = useState(form.action !== 'setup')
  const [values, setValues] = useState<Record<string, string>>({})
  const [provider, setProvider] = useState(form.provider ?? form.providers?.[0]?.id ?? null)
  const [sent, setSent] = useState<ApprovalChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const decided = request.decision ?? sent
  const id = request.requestId
  const setup = form.action === 'setup'
  const fields = form.fields.filter(field => !field.provider || field.provider === provider)
  const missing =
    setup && fields.some(field => !field.optional && !field.set && !values[field.key]?.trim())
  const about = form.providers?.find(option => option.id === provider)?.description

  // Settled only once the daemon took the answer; a failure keeps the form.
  const answer = async (choice: ApprovalChoice) => {
    setBusy(true)
    try {
      const typed = Object.fromEntries(
        fields.flatMap(field => {
          const value = values[field.key]?.trim()
          return value ? [[field.key, value]] : []
        })
      )
      await onAnswer(id, choice, choice === 'deny' ? undefined : { provider, values: typed })
      setSent(choice)
      setValues({})
    } catch {
      // The app shows the error; the form stays for another try.
    } finally {
      setBusy(false)
    }
  }

  // What an install runs stays on the card: the user approves exactly that.
  const run = form.action === 'install' ? (form.run ?? (form.detail ? [form.detail] : [])) : []

  return (
    <ConnectCard
      joined={joined}
      accessibilityLabel={decided ? undefined : `${VERBS[form.action]} ${form.name}`}
      action={
        open ? null : (
          <Button
            label={VERBS[form.action]}
            onPress={() => setOpen(true)}
            style={cardStyles.headButton}
            testID={`plugin-${id}-open`}
          />
        )
      }
      icon={<PluginIcon icon={pluginFormIcon(form)} size={36} />}
      status={
        decided ? (
          <CardStatus
            done={decided !== 'deny'}
            label={decided === 'deny' ? 'Not now' : DONE[form.action]}
          />
        ) : null
      }
      subtitle={form.description || null}
      testID={`plugin-${id}`}
      title={form.name}
    >
      {decided || !open ? null : (
        <>
          {form.other ? (
            <Text tone="muted" variant="footnote">
              For {form.bot}
            </Text>
          ) : null}
          {run.length ? (
            <View style={[styles.run, { backgroundColor: theme.fill }]}>
              <Text style={{ fontFamily: mono }} variant="caption">
                {run.join('\n')}
              </Text>
            </View>
          ) : null}
          {form.providers && form.providers.length > 1 ? (
            <View accessibilityRole="radiogroup" style={styles.providers}>
              {form.providers.map(option => {
                const chosen = option.id === provider
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: chosen }}
                    key={option.id}
                    onPress={() => setProvider(option.id)}
                    style={[styles.provider, { backgroundColor: chosen ? theme.ink : theme.fill }]}
                    testID={`plugin-${id}-provider-${option.id}`}
                  >
                    <Text style={{ color: chosen ? theme.onInk : theme.text }} variant="footnote">
                      {option.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          ) : null}
          {about ? (
            <Text tone="muted" variant="footnote">
              {about}
            </Text>
          ) : null}
          {fields.map((field, index) => (
            <CardField
              autoFocus={setup && index === 0}
              key={field.key}
              label={field.label}
              link={field.url}
              onChangeText={value => setValues(current => ({ ...current, [field.key]: value }))}
              placeholder={field.set ? `Saved${field.hint ? ` ${field.hint}` : ''}` : undefined}
              secret={field.secret !== false}
              testID={`plugin-${id}-${field.key}`}
              value={values[field.key] ?? ''}
            />
          ))}
          <View style={cardStyles.actions}>
            <Button
              busy={busy}
              disabled={missing}
              label={VERBS[form.action]}
              onPress={() => void answer('once')}
              style={cardStyles.button}
              testID={`plugin-${id}-submit`}
            />
            <Button
              disabled={busy}
              label="Not now"
              onPress={() => void answer('deny')}
              style={[cardStyles.button, { backgroundColor: theme.inset }]}
              testID={`plugin-${id}-cancel`}
              variant="secondary"
            />
          </View>
        </>
      )}
    </ConnectCard>
  )
}

const styles = StyleSheet.create({
  provider: { borderRadius: radius.pill, minHeight: 32, justifyContent: 'center', paddingHorizontal: 12 },
  providers: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  run: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }
})
