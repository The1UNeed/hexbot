import { ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { daemonInfo, modelsList, pairingCode } from '../../lib/api'
import { getBridge } from '../../lib/bridge'
import type { ApprovalMode, ModelOption, PairingCode, Provider } from '../../lib/types'
import { useSettings } from '../../stores/settings'
import { type ThemePreference, useUi } from '../../stores/ui'

export const SETTINGS_TABS = ['providers', 'network', 'approvals', 'appearance', 'updates', 'about'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Complete settings body; the file route owns the surrounding dialog and navigation. */
export function SettingsPanel({ tab }: { tab: string }): React.JSX.Element {
  return <section aria-label={`${tab} settings`} className="min-w-0 p-6">
    {tab === 'providers' && <ProvidersSettings />}
    {tab === 'network' && <NetworkSettings />}
    {tab === 'approvals' && <ApprovalsSettings />}
    {tab === 'appearance' && <AppearanceSettings />}
    {tab === 'updates' && <UpdatesSettings />}
    {tab === 'about' && <AboutSettings />}
  </section>
}

function Heading({ children, description }: { children: React.ReactNode; description: string }) {
  return <header className="mb-6"><h2 className="text-[length:var(--text-title)] font-semibold">{children}</h2><p className="mt-1 text-muted">{description}</p></header>
}

export function ProvidersSettings(): React.JSX.Element {
  const providers = useSettings(state => state.providers)
  const refresh = useSettings(state => state.refreshProviders)
  const setKey = useSettings(state => state.setProviderKey)
  const clearKey = useSettings(state => state.clearProviderKey)
  useEffect(() => { void refresh() }, [refresh])

  return <><Heading description="Connect the model providers your bots can use.">Providers</Heading><div className="divide-y divide-border">{providers.map(provider => <ProviderRow clearKey={clearKey} key={provider.id} provider={provider} setKey={setKey} />)}</div><p className="mt-6 text-[length:var(--text-secondary)] text-muted">Hexbot does not include any model credits. Usage is billed by your providers.</p></>
}

function ProviderRow({ clearKey, provider, setKey }: { clearKey: (provider: string) => Promise<void>; provider: Provider; setKey: (provider: string, key: string) => Promise<void> }) {
  const [key, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const save = async () => { setBusy(true); setResult(null);

 try { await setKey(provider.id, key); setDraft(''); setResult('Key saved.') } catch (error) { setResult(errorText(error)) } finally { setBusy(false) } }

  const test = async () => { setBusy(true); setResult(null);

 try { if (key) {await setKey(provider.id, key);} const models = await modelsList(provider.id); setResult(`${models.all.length} models available.`); setDraft('') } catch (error) { setResult(errorText(error)) } finally { setBusy(false) } }

  return <div className="py-4"><div className="flex items-center gap-3"><div className="min-w-0 flex-1"><h3 className="font-medium">{provider.label}</h3><Chip className="mt-1" tone={provider.configured ? 'success' : 'neutral'}>{provider.configured ? 'Configured' : 'Not configured'}</Chip></div>{provider.configured && <Button aria-label={`Remove ${provider.label} key`} icon={<Trash2 size={14} />} onClick={() => void clearKey(provider.id)} size="sm" variant="ghost">Remove</Button>}</div><div className="mt-3 flex gap-2"><Input aria-label={`${provider.label} API key`} onChange={event => setDraft(event.target.value)} placeholder="API key" type="password" value={key} /><Button busy={busy} disabled={!key} onClick={() => void save()}>Save</Button><Button busy={busy} onClick={() => void test()}>Test</Button></div>{result && <p className="mt-2 text-[length:var(--text-secondary)] text-muted" role="status">{result}</p>}</div>
}

export function NetworkSettings(): React.JSX.Element {
  const network = useSettings(state => state.network)
  const devices = useSettings(state => state.devices)
  const refreshNetwork = useSettings(state => state.refreshNetwork)
  const refreshDevices = useSettings(state => state.refreshDevices)
  const setLan = useSettings(state => state.setLanEnabled)
  const revoke = useSettings(state => state.revokeDevice)
  const [code, setCode] = useState<PairingCode | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [restartRequired, setRestartRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void Promise.all([refreshNetwork(), refreshDevices()]) }, [refreshDevices, refreshNetwork])
  useEffect(() => { if (network?.lan_enabled) {void pairingCode().then(setCode).catch(cause => setError(errorText(cause)))} }, [network?.lan_enabled])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000);

 return () => window.clearInterval(timer) }, [])
  const seconds = code ? Math.max(0, Math.ceil((code.expires_at * (code.expires_at < 10_000_000_000 ? 1000 : 1) - now) / 1000)) : 0

  const toggle = async (enabled: boolean) => { try { await setLan(enabled); setRestartRequired(true) } catch (cause) { setError(errorText(cause)) } }

  return <><Heading description="Pair devices directly with this daemon on your local network.">Network</Heading><label className="flex items-center justify-between gap-4 border-b border-border pb-4"><span><strong className="block">Allow other devices on this network</strong><span className="text-[length:var(--text-secondary)] text-muted">Makes this daemon reachable from your LAN.</span></span><input aria-label="Allow other devices on this network" checked={network?.lan_enabled ?? false} className="size-5 accent-accent" onChange={event => void toggle(event.target.checked)} type="checkbox" /></label>{restartRequired && <p className="mt-4 rounded-control bg-warning/12 p-3 text-warning" role="status">Restart the daemon for this network change to take effect.</p>}{error && <p className="mt-4 text-danger" role="alert">{error}</p>}{network?.lan_enabled && <div className="mt-5 space-y-6"><div><h3 className="font-medium">Addresses</h3><ul className="mt-2 font-mono text-[length:var(--text-secondary)]">{network.addresses.map(address => <li key={address}>{address}:{network.port}</li>)}</ul></div>{code && <div className="grid grid-cols-[1fr_auto] items-center gap-5"><div><h3 className="font-medium">Pairing code</h3><p className="mt-1 font-mono text-2xl tracking-[0.2em]">{code.code}</p><p className="mt-1 text-muted">Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</p><Button className="mt-3" icon={<RefreshCw size={14} />} onClick={() => void pairingCode().then(setCode)} size="sm">Regenerate</Button></div><PairingQr link={code.link} /></div>}<div><h3 className="font-medium">Paired devices</h3><ul className="mt-2 divide-y divide-border">{devices.map(device => <li className="flex items-center gap-3 py-3" key={device.id}><div className="flex-1"><span>{device.name}</span>{device.current && <Chip className="ml-2">This device</Chip>}<p className="text-[length:var(--text-meta)] text-muted">Last seen {formatDate(device.last_seen_at)}</p></div>{!device.current && <Button onClick={() => void revoke(device.id)} size="sm" variant="ghost">Revoke</Button>}</li>)}</ul></div></div>}</>
}

function PairingQr({ link }: { link: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => { if (canvas.current) {void QRCode.toCanvas(canvas.current, link, { margin: 1, width: 132 })} }, [link])

  return <canvas aria-label="Pairing QR code" ref={canvas} />
}

function formatDate(value: null | number): string { return value ? new Date(value * (value < 10_000_000_000 ? 1000 : 1)).toLocaleString() : 'never' }

const MODES: { description: string; label: string; value: ApprovalMode }[] = [
  { description: 'Ask before every tool action that needs permission.', label: 'Manual', value: 'manual' },
  { description: 'Let a small model approve low-risk actions and ask you about the rest.', label: 'Auto', value: 'smart' },
  { description: 'Run actions without approval prompts.', label: 'Off', value: 'off' }
]

export function ApprovalsSettings(): React.JSX.Element {
  const settings = useSettings(state => state.settings)
  const models = useSettings(state => state.models)
  const refresh = useSettings(state => state.refresh)
  const refreshModels = useSettings(state => state.refreshModels)
  const patch = useSettings(state => state.patch)
  useEffect(() => { void Promise.all([refresh(), refreshModels()]) }, [refresh, refreshModels])
  const curated = models.curated.length ? models.curated : models.all

  return <><Heading description="Choose when Hexbot asks before a bot uses a protected tool.">Approvals</Heading><fieldset className="space-y-1"><legend className="sr-only">Approval mode</legend>{MODES.map(mode => <label className="flex cursor-pointer gap-3 border-b border-border py-3" key={mode.value}><input checked={settings?.approval_mode === mode.value} name="approval-mode" onChange={() => void patch({ approval_mode: mode.value })} type="radio" value={mode.value} /><span><strong className="block">{mode.label}</strong><span className="text-[length:var(--text-secondary)] text-muted">{mode.description}</span></span></label>)}</fieldset>{settings?.approval_mode === 'smart' && <label className="mt-5 block"><span className="mb-2 block font-medium">Auto approver model</span><Select label="Auto approver model" onValueChange={model => void patch({ auto_approver_model: model })} options={modelOptions(curated)} placeholder="Choose a model" value={settings.auto_approver_model ?? undefined} /></label>}</>
}

function modelOptions(models: ModelOption[]) { return models.map(model => ({ label: model.label, value: model.id })) }

export function AppearanceSettings(): React.JSX.Element {
  const theme = useUi(state => state.theme)
  const setTheme = useUi(state => state.setTheme)

  return <><Heading description="Set the colour theme for this window.">Appearance</Heading><fieldset className="flex gap-3"><legend className="sr-only">Theme</legend>{(['system', 'light', 'dark'] as ThemePreference[]).map(item => <label className="flex min-w-28 cursor-pointer items-center gap-2 rounded-control border border-border p-3 capitalize" key={item}><input checked={theme === item} name="theme" onChange={() => setTheme(item)} type="radio" />{item}</label>)}</fieldset></>
}

export function UpdatesSettings(): React.JSX.Element {
  const bridge = getBridge()
  const [version, setVersion] = useState<string>('—')
  const [status, setStatus] = useState('Up to date')
  useEffect(() => { void daemonInfo().then(info => setVersion(info.version));

 if (!bridge) {return;}

 return bridge.updater.onStatus(next => setStatus(next.message ?? next.state)) }, [bridge])

  return <><Heading description="Version and release status for Hexbot.">Updates</Heading><p>Daemon version: <strong>{version}</strong></p>{bridge ? <div className="mt-4"><p className="text-muted" role="status">{status}</p><Button className="mt-3" onClick={() => void bridge.updater.check().then(next => setStatus(next.message ?? next.state))}>Check now</Button></div> : <p className="mt-3 text-muted">Updates are handled by the app running this browser.</p>}</>
}

export function AboutSettings(): React.JSX.Element {
  const bridge = getBridge()
  const [info, setInfo] = useState<{ hermes_version: null | string; version: string } | null>(null)
  useEffect(() => { void daemonInfo().then(setInfo) }, [])
  const open = (url: string) => bridge ? bridge.openExternal(url) : window.open(url, '_blank', 'noopener,noreferrer')

  return <><Heading description="Hexbot is a personal AI agent built on Hermes Agent.">About</Heading><dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2"><dt className="text-muted">Hexbot</dt><dd>{bridge?.version ?? info?.version ?? '—'}</dd><dt className="text-muted">Hermes Agent</dt><dd>{info?.hermes_version ?? '—'}</dd><dt className="text-muted">License</dt><dd>MIT</dd></dl><div className="mt-6 flex gap-2"><Button icon={<ExternalLink size={14} />} onClick={() => void open('https://github.com/NousResearch/hermes-agent')}>Source</Button><Button icon={<ExternalLink size={14} />} onClick={() => void open('https://hexbot.app')}>Website</Button></div></>
}
