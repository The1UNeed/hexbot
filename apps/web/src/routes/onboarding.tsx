import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { botsCreate, modelsList, providersList, providersSetKey } from '../lib/api'
import { type DaemonProgress, getBridge, isElectron } from '../lib/bridge'
import { connectTo } from '../lib/connection'
import type { ModelOption, Provider } from '../lib/types'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/onboarding')({ component: OnboardingPage })

type OnboardingStep = 'bot' | 'choice' | 'existing' | 'install' | 'providers'

export function initialOnboardingStep(input: {
  connected: boolean
  hasBots: boolean
  isElectron: boolean
}): OnboardingStep {
  if (input.hasBots) {
    return 'existing'
  }

  if (!input.connected && input.isElectron) {
    return 'choice'
  }

  return 'providers'
}

export function OnboardingChoiceCards(props: { onConnect: () => void; onLocal: () => void }) {
  const choices = [
    {
      description: 'Pair with a daemon on your network or a Tailscale address.',
      onClick: props.onConnect,
      title: 'Connect to a Hexbot daemon'
    },
    {
      description: 'Install the runtime on this computer and run bots here.',
      onClick: props.onLocal,
      title: 'Run Hexbot on this machine'
    }
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {choices.map(choice => (
        <button
          className="rounded-panel border border-border bg-background p-4 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
          key={choice.title}
          onClick={choice.onClick}
          type="button"
        >
          <span className="block font-semibold">{choice.title}</span>
          <span className="mt-1 block text-secondary text-muted">{choice.description}</span>
        </button>
      ))}
    </div>
  )
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)

function OnboardingPage() {
  const navigate = useNavigate()
  const connected = useConnection(state => state.status === 'connected')
  const order = useBots(state => state.order)
  const byName = useBots(state => state.byName)
  const bots = useMemo(() => order.map(name => byName[name]).filter(Boolean), [byName, order])

  const [step, setStep] = useState<OnboardingStep>(() =>
    initialOnboardingStep({ connected, hasBots: bots.length > 0, isElectron: isElectron() })
  )

  const [progress, setProgress] = useState<DaemonProgress[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [key, setKey] = useState('')

  const [models, setModels] = useState<{ all: ModelOption[]; curated: ModelOption[] }>({
    all: [],
    curated: []
  })

  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [persona, setPersona] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const configured = providers.filter(item => item.configured === true)

  const filteredProviders = useMemo(() => {
    const query = search.trim().toLowerCase()

    return [...providers]
      .sort((a, b) => Number(b.configured === true) - Number(a.configured === true))
      .filter(item => !query || `${item.label} ${item.id}`.toLowerCase().includes(query))
  }, [providers, search])

  useEffect(() => {
    const bot = bots[0]
    const section = bot?.sections_recent[0]

    if (!bot || !section) {
      return
    }

    setStep('existing')
    const last = { bot: bot.name, section: section.id }
    uiActions().setLastSection(last)
    void navigate({ to: '/b/$bot/s/$section', params: last })
  }, [bots, navigate])

  useEffect(() => {
    if (step === 'choice' && connected) {
      setStep('providers')
    }
  }, [connected, step])

  useEffect(() => {
    if (step !== 'install') {
      return
    }

    const bridge = getBridge()

    if (!bridge) {
      return
    }

    const off = bridge.daemon.onProgress(item => setProgress(items => [...items, item]))
    setBusy(true)
    void bridge.daemon
      .start()
      .then(() => connectTo({ kind: 'local' }))
      .then(() => setStep('providers'))
      .catch(reason => setError(String(reason)))
      .finally(() => setBusy(false))

    return off
  }, [step])

  useEffect(() => {
    if (step !== 'providers' || !connected) {
      return
    }

    void providersList()
      .then(result => setProviders(result.providers))
      .catch(reason => setError(String(reason)))
  }, [connected, step])

  const testProvider = async () => {
    if (!selectedProvider) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      if (key.trim()) {
        await providersSetKey(selectedProvider, key.trim())
      }

      const result = await modelsList(selectedProvider)
      setProviders(items =>
        items.map(item => (item.id === selectedProvider ? { ...item, configured: true } : item))
      )
      setModels(result)
      setProvider(selectedProvider)
      setModel((result.curated.length ? result.curated : result.all)[0]?.id ?? '')
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const continueToBot = async () => {
    const nextProvider = provider || configured[0]?.id

    if (!nextProvider) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const result = await modelsList(nextProvider)
      setProvider(nextProvider)
      setModels(result)
      setModel((result.curated.length ? result.curated : result.all)[0]?.id ?? '')
      setStep('bot')
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const createBot = async () => {
    if (!NAME_PATTERN.test(name)) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const result = await botsCreate({
        display_name: displayName.trim(),
        model,
        name,
        persona: persona.trim(),
        provider
      })

      const last = { bot: result.bot.name, section: result.section.id }
      uiActions().setLastSection(last)
      await navigate({ to: '/b/$bot/s/$section', params: last })
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'existing') {
    return null
  }

  const stepNumber = step === 'bot' ? 3 : step === 'providers' ? 2 : 1

  const copy = {
    bot: ['Set up Hexbot', 'Create your first bot and choose the model it will use.'],
    choice: ['Where should Hexbot run?', 'Choose a daemon on another device or install one here.'],
    install: ['Set up Hexbot', 'Hexbot is installing the local runtime and its dependencies.'],
    providers: ['Set up Hexbot', 'Connect at least one model provider to continue.']
  }[step]

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="w-full max-w-[520px] space-y-6 rounded-panel border border-border bg-surface p-6">
        <header>
          <p className="mb-2 text-meta text-muted">Step {stepNumber} of 3</p>
          <h1 className="text-[length:var(--text-title)] font-semibold">{copy[0]}</h1>
          <p className="mt-1 text-secondary text-muted">{copy[1]}</p>
        </header>

        {step === 'choice' ? (
          <OnboardingChoiceCards
            onConnect={() => void navigate({ to: '/connect' })}
            onLocal={() => setStep('install')}
          />
        ) : null}

        {step === 'install' ? (
          <div>
            <p>{progress.at(-1)?.message ?? 'Preparing the local runtime…'}</p>
            <progress className="mt-3 w-full" max={1} value={progress.at(-1)?.fraction} />
            <details className="mt-3 text-secondary text-muted">
              <summary>Install log</summary>
              <pre className="mt-2 whitespace-pre-wrap font-mono text-meta">
                {progress.map(item => item.detail ?? item.message).join('\n')}
              </pre>
            </details>
          </div>
        ) : null}

        {step === 'providers' ? (
          <div className="space-y-4">
            <p className="text-secondary text-muted">
              Hexbot does not include any model credits. Usage is billed by your providers.
            </p>
            <Input
              aria-label="Search providers"
              data-testid="onboarding-provider-search"
              onChange={event => setSearch(event.target.value)}
              placeholder="Search providers"
              value={search}
            />
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {filteredProviders.map(item => (
                <button
                  className={`flex w-full items-center justify-between rounded-control border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent ${selectedProvider === item.id ? 'border-accent bg-surface-2' : 'border-border'}`}
                  data-testid={`onboarding-provider-item-${item.id}`}
                  key={item.id}
                  onClick={() => {
                    setSelectedProvider(item.id)
                    setKey('')
                  }}
                  type="button"
                >
                  <span>{item.label}</span>
                  {item.configured ? (
                    <span className="text-meta text-success">Configured</span>
                  ) : null}
                </button>
              ))}
            </div>
            {selectedProvider ? (
              <div className="space-y-2">
                <label className="block" htmlFor="provider-key">
                  Provider key
                </label>
                <Input
                  data-testid="onboarding-provider-key-input"
                  id="provider-key"
                  onChange={event => setKey(event.target.value)}
                  placeholder="API key"
                  type="password"
                  value={key}
                />
                <div className="flex justify-end">
                  <Button busy={busy} onClick={() => void testProvider()}>
                    Test
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                busy={busy}
                data-testid="onboarding-continue"
                disabled={configured.length === 0}
                onClick={() => void continueToBot()}
                variant="primary"
              >
                Continue
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'bot' ? (
          <div className="space-y-4">
            <label className="block space-y-2">
              <span>Display name</span>
              <Input
                data-testid="onboarding-bot-display-input"
                onChange={event => {
                  setDisplayName(event.target.value)

                  if (!nameEdited) {
                    setName(slugify(event.target.value))
                  }
                }}
                value={displayName}
              />
            </label>
            <label className="block space-y-2">
              <span>Name</span>
              <Input
                data-testid="onboarding-bot-name-input"
                invalid={Boolean(name) && !NAME_PATTERN.test(name)}
                onChange={event => {
                  setNameEdited(true)
                  setName(event.target.value)
                }}
                value={name}
              />
              <span
                className={`block text-meta ${name && !NAME_PATTERN.test(name) ? 'text-danger' : 'text-muted'}`}
              >
                Lowercase letters, numbers, hyphens, or underscores. Up to 64 characters.
              </span>
            </label>
            <label className="block space-y-2">
              <span>
                Persona <span className="text-muted">(optional)</span>
              </span>
              <Textarea onChange={event => setPersona(event.target.value)} value={persona} />
            </label>
            <label className="block space-y-2">
              <span>Provider</span>
              <Select
                label="Provider"
                onValueChange={value => {
                  setProvider(value)
                  void modelsList(value).then(result => {
                    setModels(result)
                    setModel((result.curated.length ? result.curated : result.all)[0]?.id ?? '')
                  })
                }}
                options={configured.map(item => ({ label: item.label, value: item.id }))}
                value={provider}
              />
            </label>
            <label className="block space-y-2">
              <span>Model</span>
              <div data-testid="onboarding-model-select">
                <Select
                  label="Model"
                  onValueChange={setModel}
                  options={[
                    ...models.curated.map(item => ({
                      label: `Curated · ${item.label}`,
                      value: item.id
                    })),
                    ...models.all
                      .filter(item => !models.curated.some(curated => curated.id === item.id))
                      .map(item => ({ label: item.label, value: item.id }))
                  ]}
                  value={model}
                />
              </div>
            </label>
            <div className="flex justify-end" data-testid="onboarding-create">
              <Button
                busy={busy}
                data-testid="onboarding-create-button"
                disabled={!NAME_PATTERN.test(name) || !displayName.trim() || !model || !provider}
                onClick={() => void createBot()}
                variant="primary"
              >
                Create bot
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="text-secondary text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  )
}
