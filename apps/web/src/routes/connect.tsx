import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { defaultDeviceName } from '../lib/bridge'
import { connectTo, InvalidCodeError, pairWithDaemon, probeDaemon, targetOrigin, UnauthorizedError } from '../lib/connection'
import { formatAddress, parseAddress, parsePairLink } from '../lib/pair-link'

export const Route = createFileRoute('/connect')({ component: ConnectPage })

function ConnectPage() {
  const navigate = useNavigate()
  const [address, setAddress] = useState('127.0.0.1:9119')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [daemonName, setDaemonName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const applyPaste = (value: string) => {
    const link = parsePairLink(value)

    if (link) {
      setAddress(formatAddress(link))
      setCode(link.code)
    }
  }

  const probe = async () => {
    const parts = parseAddress(address)

    if (!parts) {return setError('Enter a valid daemon address.')}
    setBusy(true); setError(null)

    try {
      const result = await probeDaemon(targetOrigin({ kind: 'remote', ...parts, deviceToken: '' }))
      setDaemonName(result.daemonName ?? formatAddress(parts))
    } catch { setError('The daemon could not be reached.') }
    finally { setBusy(false) }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const parts = parseAddress(address)

    if (!parts) {return setError('Enter a valid daemon address.')}
    setBusy(true); setError(null)

    try {
      const paired = await pairWithDaemon(parts.host, parts.port, code.trim(), deviceName.trim())
      setDaemonName(paired.daemonName)
      await connectTo({ kind: 'remote', ...parts, deviceToken: paired.deviceToken })
      await navigate({ to: '/' })
    } catch (reason) {
      setError(reason instanceof InvalidCodeError ? 'The pairing code is invalid or expired.' : reason instanceof UnauthorizedError ? 'This device was revoked. Pair it again.' : 'The daemon could not be reached.')
    } finally { setBusy(false) }
  }

  return <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground"><form className="w-full max-w-md space-y-5" onSubmit={submit}><header><h1 className="text-[length:var(--text-title)] font-semibold">Connect to Hexbot</h1><p className="mt-1 text-secondary text-muted">Enter the address and one-time pairing code shown by the daemon.</p></header><label className="block space-y-1.5"><span>Daemon address</span><Input data-testid="connect-address-input" onChange={e => { setAddress(e.target.value); applyPaste(e.target.value) }} onPaste={e => applyPaste(e.clipboardData.getData('text'))} value={address} /></label><label className="block space-y-1.5"><span>Pairing code</span><Input data-testid="connect-code-input" onChange={e => setCode(e.target.value)} value={code} /></label><label className="block space-y-1.5"><span>Device name</span><Input onChange={e => setDeviceName(e.target.value)} value={deviceName} /></label>{daemonName ? <p className="text-success">Found {daemonName}</p> : null}{error ? <p className="text-danger" role="alert">{error}</p> : null}<div className="flex gap-2"><Button busy={busy} onClick={() => void probe()} type="button">Probe</Button><Button busy={busy} data-testid="connect-submit" disabled={!code.trim() || !deviceName.trim()} type="submit" variant="primary">Connect</Button></div></form></main>
}
