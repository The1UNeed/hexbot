import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { isSubscription, ProviderPanel } from '../components/provider-panel'
import { AvatarBuilder } from '../components/ui/avatar-builder'
import { Button } from '../components/ui/button'
import { Chip } from '../components/ui/chip'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { botsCreate, modelsList, providersList, settingsGet, settingsSet } from '../lib/api'
import { avatarPng, type AvatarStyle, DEFAULT_AVATAR_STYLE } from '../lib/avatar-builder'
import { BOT_TEMPLATES } from '../lib/bot-templates'
import { type DaemonProgress, getBridge, hasLocalRuntime, isElectron } from '../lib/bridge'
import { cn } from '../lib/cn'
import { connectTo } from '../lib/connection'
import type { ModelOption, Provider } from '../lib/types'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/onboarding')({ component: OnboardingPage })

type OnboardingStep =
  'bot' | 'choice' | 'connect' | 'defaults' | 'existing' | 'install' | 'providers'

export function initialOnboardingStep(input: {
  connected: boolean
  hasBots: boolean
  hasLocalRuntime: boolean
  isElectron: boolean
}): OnboardingStep {
  if (input.hasBots) {
    return 'existing'
  }

  if (!input.connected && input.isElectron) {
    // The client-only package has nothing to install, so the only way in is
    // to pair with a daemon.
    return input.hasLocalRuntime ? 'choice' : 'connect'
  }

  return 'providers'
}

export function OnboardingChoiceCards(props: { onConnect: () => void; onLocal: () => void }) {
  const choices = [
    {
      description: 'Install the runtime on this computer and run bots here.',
      onClick: props.onLocal,
      title: 'Run Hexbot on this machine'
    },
    {
      description: 'Pair with a daemon on your network or a Tailscale address.',
      onClick: props.onConnect,
      title: 'Connect to a Hexbot daemon'
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

const STEPS: { id: OnboardingStep; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'bot', label: 'First bot' }
]

function Stepper({ current }: { current: OnboardingStep }) {
  const index = STEPS.findIndex(step => step.id === current)

  if (index < 0) {
    return null
  }

  return (
    <ol className="flex items-center gap-2 text-[length:var(--text-meta)] text-muted">
      {STEPS.map((step, position) => (
        <li className="flex items-center gap-2" key={step.id}>
          <span
            className={cn(
              'grid size-5 place-items-center rounded-full border text-[10px] font-semibold',
              position < index
                ? 'border-accent bg-accent text-accent-fg'
                : position === index
                  ? 'border-accent text-accent'
                  : 'border-border'
            )}
          >
            {position < index ? <Check size={11} /> : position + 1}
          </span>
          <span className={position === index ? 'text-foreground' : undefined}>{step.label}</span>
          {position < STEPS.length - 1 ? <span className="mx-1 h-px w-6 bg-border" /> : null}
        </li>
      ))}
    </ol>
  )
}

function ProvidersStep({
  onContinue,
  onError
}: {
  onContinue: (configured: Provider[]) => void
  onError: (message: string) => void
}) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const refresh = useCallback(async () => {
    try {
      const result = await providersList()
      setProviders(result.providers)
    } catch (reason) {
      onError(String(reason))
    }
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const configured = providers.filter(item => item.configured === true)

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()

    return providers.filter(
      item => !query || `${item.label} ${item.id}`.toLowerCase().includes(query)
    )
  }, [providers, search])

  return (
    <div className="space-y-4">
      <Input
        aria-label="Search providers"
        data-testid="onboarding-provider-search"
        onChange={event => setSearch(event.target.value)}
        placeholder="Search providers"
        value={search}
      />
      <ul className="max-h-[46vh] divide-y divide-border overflow-y-auto rounded-panel border border-border">
        {filtered.map(item => {
          const open = selected === item.id

          return (
            <li key={item.id}>
              <button
                aria-expanded={open}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent',
                  open && 'bg-surface-2'
                )}
                data-testid={`onboarding-provider-item-${item.id}`}
                onClick={() => setSelected(open ? null : item.id)}
                type="button"
              >
                <span className="font-medium">{item.label}</span>
                <Chip
                  tone={item.configured ? 'success' : isSubscription(item) ? 'accent' : 'neutral'}
                >
                  {item.configured
                    ? 'Connected'
                    : isSubscription(item)
                      ? 'Subscription'
                      : 'API key'}
                </Chip>
              </button>
              {open ? (
                <div className="border-t border-border bg-background px-4 py-4">
                  <ProviderPanel onConfigured={refresh} provider={item} />
                </div>
              ) : null}
            </li>
          )
        })}
        {filtered.length === 0 ? (
          <li className="px-4 py-6 text-center text-secondary text-muted">No providers match.</li>
        ) : null}
      </ul>
      <div className="flex items-center justify-between">
        <span className="text-secondary text-muted">
          {configured.length === 0
            ? 'Connect at least one provider to continue.'
            : `${configured.length} connected. Add more now, or later in Settings.`}
        </span>
        <Button
          data-testid="onboarding-continue"
          disabled={configured.length === 0}
          onClick={() => onContinue(configured)}
          variant="primary"
        >
          Continue
        </Button>
      </div>
    </div>
  )
}

interface ModelChoice {
  label: string
  value: string
}

async function loadModelChoices(providers: Provider[]): Promise<ModelChoice[]> {
  const lists = await Promise.all(
    providers.map(provider =>
      modelsList(provider.id)
        .then(result => ({ provider, result }))
        .catch(() => ({ provider, result: { all: [], curated: [] } }))
    )
  )

  return lists.flatMap(({ provider, result }) => {
    const models: ModelOption[] = result.curated.length ? result.curated : result.all

    return models.map(model => ({
      label: `${provider.label} · ${model.label}`,
      value: `${provider.id}/${model.id}`
    }))
  })
}

function DefaultsStep({
  configured,
  onContinue,
  onError
}: {
  configured: Provider[]
  onContinue: (defaultModel: string | null) => void
  onError: (message: string) => void
}) {
  const [choices, setChoices] = useState<ModelChoice[] | null>(null)
  const [defaultModel, setDefaultModel] = useState<string>('')
  const [fallback, setFallback] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void Promise.all([loadModelChoices(configured), settingsGet().catch(() => null)]).then(
      ([models, settings]) => {
        setChoices(models)
        setDefaultModel(settings?.default_model ?? models[0]?.value ?? '')
        setFallback(settings?.fallback_model ?? '')
      }
    )
  }, [configured])

  const save = async () => {
    setBusy(true)

    try {
      await settingsSet({ default_model: defaultModel || null, fallback_model: fallback || null })
      onContinue(defaultModel || null)
    } catch (reason) {
      onError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const fallbackChoices = (choices ?? []).filter(item => item.value !== defaultModel)

  return (
    <div className="space-y-5">
      <label className="block space-y-2">
        <span className="font-medium">Default model</span>
        <span className="block text-secondary text-muted">
          Pre-filled when you create a bot. Each bot can still use its own.
        </span>
        <Select
          label="Default model"
          onValueChange={setDefaultModel}
          options={choices ?? []}
          placeholder={choices ? 'Choose a model' : 'Loading models…'}
          value={defaultModel || undefined}
        />
      </label>
      <label className="block space-y-2">
        <span className="font-medium">
          Fallback <span className="text-muted">(optional)</span>
        </span>
        <span className="block text-secondary text-muted">
          Used when a bot's own provider is down or rate limited.
        </span>
        <Select
          label="Fallback model"
          onValueChange={value => setFallback(value === '__none__' ? '' : value)}
          options={[{ label: 'None', value: '__none__' }, ...fallbackChoices]}
          placeholder="None"
          value={fallback || '__none__'}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button onClick={() => onContinue(null)} variant="ghost">
          Skip
        </Button>
        <Button
          busy={busy}
          data-testid="onboarding-defaults-continue"
          disabled={!defaultModel}
          onClick={() => void save()}
          variant="primary"
        >
          Continue
        </Button>
      </div>
    </div>
  )
}

function BotStep({
  configured,
  defaultModel,
  onCreated,
  onError
}: {
  configured: Provider[]
  defaultModel: string | null
  onCreated: (bot: string, section: string) => void
  onError: (message: string) => void
}) {
  const [style, setStyle] = useState<AvatarStyle>(DEFAULT_AVATAR_STYLE)
  const [displayName, setDisplayName] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [template, setTemplate] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [persona, setPersona] = useState('')

  const [provider, setProvider] = useState(
    () => defaultModel?.split('/')[0] ?? configured[0]?.id ?? ''
  )

  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState(() => defaultModel?.split('/').slice(1).join('/') ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!provider) {
      return
    }

    void modelsList(provider)
      .then(result => {
        const list = result.curated.length ? result.curated : result.all
        setModels(list)
        setModel(current =>
          list.some(item => item.id === current) ? current : (list[0]?.id ?? '')
        )
      })
      .catch(reason => onError(String(reason)))
  }, [onError, provider])

  const pickTemplate = (id: string) => {
    const item = BOT_TEMPLATES.find(entry => entry.id === id)

    if (!item) {
      return
    }

    setTemplate(id)
    setTitle(item.title)
    setDescription(item.description)
    setPersona(item.persona)
  }

  const valid = NAME_PATTERN.test(name) && displayName.trim() && provider && model

  const create = async () => {
    if (!valid) {
      return
    }

    setBusy(true)

    try {
      const avatar = await avatarPng(style)

      const result = await botsCreate({
        ...(avatar ? { avatar } : {}),
        description: description.trim(),
        display_name: displayName.trim(),
        model,
        name,
        persona: persona.trim(),
        provider,
        title: title.trim()
      })

      onCreated(result.bot.name, result.section.id)
    } catch (reason) {
      onError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <AvatarBuilder onChange={setStyle} value={style} />
      <label className="block space-y-2">
        <span className="font-medium">Name</span>
        <Input
          autoFocus
          className="h-11 text-[length:var(--text-title)] font-semibold"
          data-testid="onboarding-bot-display-input"
          onChange={event => {
            setDisplayName(event.target.value)

            if (!nameEdited) {
              setName(slugify(event.target.value))
            }
          }}
          placeholder="What should we call it?"
          value={displayName}
        />
        <span className="flex items-center gap-2 text-[length:var(--text-meta)] text-muted">
          Handle
          <input
            aria-label="Bot handle"
            className={cn(
              'min-w-0 flex-1 bg-transparent font-mono outline-none',
              name && !NAME_PATTERN.test(name) ? 'text-danger' : 'text-foreground'
            )}
            data-testid="onboarding-bot-name-input"
            onChange={event => {
              setNameEdited(true)
              setName(event.target.value)
            }}
            value={name}
          />
        </span>
      </label>
      <div className="space-y-2">
        <span className="font-medium">Role</span>
        <div className="flex flex-wrap gap-2">
          {BOT_TEMPLATES.map(item => (
            <button
              aria-pressed={template === item.id}
              className={cn(
                'rounded-full border px-3 py-1.5 text-secondary transition-colors hover:bg-surface-2',
                template === item.id ? 'border-accent bg-accent/12 text-accent' : 'border-border'
              )}
              key={item.id}
              onClick={() => pickTemplate(item.id)}
              type="button"
            >
              {item.title}
            </button>
          ))}
        </div>
        {template ? <p className="text-secondary text-muted">{description}</p> : null}
      </div>
      <details className="group">
        <summary className="cursor-pointer text-secondary text-muted">
          Customise the persona
        </summary>
        <div className="mt-3 space-y-3">
          <Input
            aria-label="Bot title"
            onChange={event => setTitle(event.target.value)}
            placeholder="Title"
            value={title}
          />
          <Input
            aria-label="Bot description"
            onChange={event => setDescription(event.target.value)}
            placeholder="One-line description"
            value={description}
          />
          <Textarea
            aria-label="Persona"
            onChange={event => setPersona(event.target.value)}
            placeholder="How should it think and talk?"
            value={persona}
          />
        </div>
      </details>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-2">
          <span className="font-medium">Provider</span>
          <Select
            label="Provider"
            onValueChange={setProvider}
            options={configured.map(item => ({ label: item.label, value: item.id }))}
            value={provider}
          />
        </label>
        <label className="block space-y-2">
          <span className="font-medium">Model</span>
          <div data-testid="onboarding-model-select">
            <Select
              label="Model"
              onValueChange={setModel}
              options={models.map(item => ({ label: item.label, value: item.id }))}
              placeholder="Choose a model"
              value={model || undefined}
            />
          </div>
        </label>
      </div>
      <div className="flex justify-end" data-testid="onboarding-create">
        <Button
          busy={busy}
          data-testid="onboarding-create-button"
          disabled={!valid}
          onClick={() => void create()}
          variant="primary"
        >
          Create bot
        </Button>
      </div>
    </div>
  )
}

function OnboardingPage() {
  const navigate = useNavigate()
  const connected = useConnection(state => state.status === 'connected')
  const order = useBots(state => state.order)
  const byName = useBots(state => state.byName)
  const bots = useMemo(() => order.map(name => byName[name]).filter(Boolean), [byName, order])

  const [step, setStep] = useState<OnboardingStep>(() =>
    initialOnboardingStep({
      connected,
      hasBots: bots.length > 0,
      hasLocalRuntime: hasLocalRuntime(),
      isElectron: isElectron()
    })
  )

  const [progress, setProgress] = useState<DaemonProgress[]>([])
  const [configured, setConfigured] = useState<Provider[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const onError = useCallback((message: string) => setError(message), [])

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
    if ((step === 'choice' || step === 'connect') && connected) {
      setStep('providers')
    }
  }, [connected, step])

  useEffect(() => {
    if (step === 'connect') {
      void navigate({ to: '/connect' })
    }
  }, [navigate, step])

  useEffect(() => {
    if (step !== 'install') {
      return
    }

    const bridge = getBridge()

    if (!bridge) {
      return
    }

    const off = bridge.daemon.onProgress(item => setProgress(items => [...items, item]))
    void bridge.daemon
      .start()
      .then(() => connectTo({ kind: 'local' }))
      .then(() => setStep('providers'))
      .catch(reason => setError(String(reason)))

    return off
  }, [step])

  useEffect(() => setError(null), [step])

  if (step === 'existing' || step === 'connect') {
    return null
  }

  const copy = {
    bot: [
      'Meet your first bot',
      'Give it a face, a name and a role. You can change all of it later.'
    ],
    choice: ['Where should Hexbot run?', 'Choose a daemon on another device or install one here.'],
    defaults: [
      'Pick your defaults',
      'The model new bots start with, and where to go when it fails.'
    ],
    install: ['Setting up Hexbot', 'Installing the local runtime and its dependencies.'],
    providers: ['Connect a provider', 'Sign in with a subscription or paste an API key.']
  }[step]

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="w-full max-w-[600px] space-y-6">
        <Stepper current={step} />
        <header>
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
          <ProvidersStep
            onContinue={list => {
              setConfigured(list)
              setStep('defaults')
            }}
            onError={onError}
          />
        ) : null}

        {step === 'defaults' ? (
          <DefaultsStep
            configured={configured}
            onContinue={model => {
              setDefaultModel(model)
              setStep('bot')
            }}
            onError={onError}
          />
        ) : null}

        {step === 'bot' ? (
          <BotStep
            configured={configured}
            defaultModel={defaultModel}
            onCreated={(bot, section) => {
              const last = { bot, section }
              uiActions().setLastSection(last)
              void navigate({ to: '/b/$bot/s/$section', params: last })
            }}
            onError={onError}
          />
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
