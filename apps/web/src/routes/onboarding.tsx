import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { botsCreate, modelsList, providersList, providersSetKey } from '../lib/api'
import { type DaemonProgress, getBridge, isElectron } from '../lib/bridge'
import { connectTo } from '../lib/connection'
import type { ModelOption, Provider } from '../lib/types'

export const Route = createFileRoute('/onboarding')({ component: OnboardingPage })
type Step = 'choice' | 'install' | 'providers' | 'bot'

function OnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('choice')
  const [progress, setProgress] = useState<DaemonProgress[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [provider, setProvider] = useState('openai-api')
  const [key, setKey] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (step !== 'install') {return}
    const bridge = getBridge()

    if (!bridge) {return}
    const off = bridge.daemon.onProgress(item => setProgress(items => [...items, item]))
    setBusy(true)
    void bridge.daemon.start().then(() => connectTo({ kind: 'local' })).then(() => setStep('providers')).catch(reason => setError(String(reason))).finally(() => setBusy(false))

    return off
  }, [step])

  useEffect(() => {
    if (step !== 'providers') {return}
    void providersList().then(result => setProviders(result.providers))
  }, [step])

  const saveProvider = async () => {
    setBusy(true); setError(null)

    try {
      await providersSetKey(provider, key)
      const result = await modelsList(provider)
      const choices = result.curated.length ? result.curated : result.all
      setModels(choices); setModel(choices[0]?.id ?? ''); setStep('bot')
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  const createBot = async () => {
    setBusy(true); setError(null)

    try {
      const result = await botsCreate({ model, name: name.trim(), persona: persona.trim(), provider })
      await navigate({ to: '/b/$bot/s/$section', params: { bot: result.bot.name, section: result.section.id } })
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  return <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground"><section className="w-full max-w-lg space-y-6"><h1 className="text-[length:var(--text-title)] font-semibold">Set up Hexbot</h1>{step === 'choice' ? <div className="grid gap-3"><Button onClick={() => void navigate({ to: '/connect' })}>Connect to a Hexbot daemon</Button>{isElectron() ? <Button onClick={() => setStep('install')} variant="primary">Run Hexbot on this machine</Button> : null}</div> : null}{step === 'install' ? <div><p>{progress.at(-1)?.message ?? 'Preparing the local runtime…'}</p><progress className="mt-3 w-full" max={1} value={progress.at(-1)?.fraction ?? undefined} /><details className="mt-3 text-secondary text-muted"><summary>Install log</summary><pre className="mt-2 whitespace-pre-wrap font-mono text-meta">{progress.map(item => item.detail ?? item.message).join('\n')}</pre></details>{busy ? null : <Button className="mt-4" onClick={() => setStep('providers')}>Continue</Button>}</div> : null}{step === 'providers' ? <div className="space-y-4"><p>Hexbot does not include any model credits. Usage is billed by your providers.</p><Select label="Provider" onValueChange={setProvider} options={(providers.length ? providers : [{ id: 'openai-api', label: 'OpenAI' } as Provider]).map(item => ({ label: item.label, value: item.id }))} value={provider} /><Input data-testid="onboarding-provider-key-input" onChange={e => setKey(e.target.value)} placeholder="Provider API key" type="password" value={key} /><Button busy={busy} disabled={!key.trim()} onClick={() => void saveProvider()} variant="primary">Save provider</Button></div> : null}{step === 'bot' ? <div className="space-y-4"><Input data-testid="onboarding-bot-name-input" onChange={e => setName(e.target.value)} placeholder="Bot name" value={name} /><Select label="Model" onValueChange={setModel} options={models.map(item => ({ label: item.label, value: item.id }))} placeholder="Choose a model" value={model} /><Textarea onChange={e => setPersona(e.target.value)} placeholder="Persona (optional)" value={persona} /><Button busy={busy} data-testid="onboarding-create-button" disabled={!name.trim() || !model} onClick={() => void createBot()} variant="primary">Create bot</Button></div> : null}{error ? <p className="text-danger" role="alert">{error}</p> : null}</section></main>
}
