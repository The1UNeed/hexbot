import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'

import type { DaemonStatus, Detection, InstallerApi, InstallResult, Pairing } from './api'
import { errorMessage } from './api'
import { friendlyError, OPTION_NAME, tildify, TRACK_NAME } from './copy'
import type { Job } from './machine'
import { Button, CopyButton, Frame, Notice } from './ui'

function Notes({ notes }: { notes: string[] }) {
  return notes.length ? (
    <div className="mt-5 space-y-2">
      {notes.map(note => (
        <Notice key={note}>{note}</Notice>
      ))}
    </div>
  ) : null
}

function isApp(path: string): boolean {
  return path.endsWith('.app') || path.endsWith('.AppImage')
}

/** Client and Full: open the app that was just installed. */
export function AppDone({
  api,
  detection,
  job,
  notes,
  result
}: {
  api: InstallerApi
  detection: Detection
  job: Job
  notes: string[]
  result: InstallResult
}) {
  const { home } = detection.locations!
  const option = result.receipt.option
  const app = result.receipt.paths.find(isApp)
  const [error, setError] = useState<null | string>(null)
  const keptService = option === 'full' && detection.installed?.service === true

  return (
    <Frame
      actions={
        <>
          <Button onClick={() => void api.quit()}>Quit</Button>
          {app ? (
            <Button
              data-primary
              onClick={() =>
                api
                  .openApp(app)
                  .catch(reason => setError(friendlyError(errorMessage(reason)).message))
              }
              variant="primary"
            >
              Open Hexbot
            </Button>
          ) : null}
        </>
      }
      aside={`${TRACK_NAME[result.receipt.channel]} ${result.receipt.version}`}
      mood="happy"
      subtitle={
        keptService
          ? 'The app uses the daemon that already runs here as a background service.'
          : option === 'full'
            ? 'Open Hexbot to set up the daemon and meet your first bot.'
            : 'Open Hexbot Client and pair it with your daemon.'
      }
      title={
        job.kind === 'repair'
          ? `Hexbot ${OPTION_NAME[option]} is up to date`
          : `Hexbot ${OPTION_NAME[option]} is installed`
      }
    >
      {app ? (
        <p className="text-muted">
          Installed at{' '}
          <span className="selectable font-mono text-[length:var(--text-secondary)] text-foreground">
            {tildify(app, home)}
          </span>
        </p>
      ) : null}
      {error ? (
        <div className="mt-5">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
      <Notes notes={notes} />
    </Frame>
  )
}

const COMMANDS: [string, string][] = [
  ['hexbot status', 'Check the daemon'],
  ['hexbot pair', 'Pair another device'],
  ['hexbot connect', 'Set up Hex Connect'],
  ['hexbot service logs', 'Read the daemon logs']
]

/** How long to keep asking a freshly started service whether it is up. */
const STATUS_TRIES = 8
const STATUS_INTERVAL_MS = 1500

function isNetworkAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase()

  return Boolean(host) && host !== 'localhost' && host !== '::1' &&
    host !== '0:0:0:0:0:0:0:1' && !/^(::ffff:)?127\./.test(host)
}

/** Headless: where the daemon can be reached, a pairing code, and the commands. */
export function HeadlessDone({
  api,
  job,
  notes,
  result
}: {
  api: InstallerApi
  job: Job
  notes: string[]
  result: InstallResult
}) {
  const [status, setStatus] = useState<DaemonStatus | null>(result.status)
  const [tries, setTries] = useState(0)

  // The service starts in the background; ask again for a few seconds.
  useEffect(() => {
    if (status?.service?.running === true || tries >= STATUS_TRIES) {
      return
    }

    const timer = setTimeout(() => {
      api.status().then(
        next => {
          setStatus(next)
          setTries(value => value + 1)
        },
        () => setTries(value => value + 1)
      )
    }, STATUS_INTERVAL_MS)

    return () => clearTimeout(timer)
  }, [api, status, tries])

  const running = status?.service?.running === true
  const port = status?.port ?? 9119

  // Pairing addresses, as `hexbot pair` prints them. Both need LAN access on.
  const lan = status?.lan_enabled === true

  const lanAddresses = lan ? (status?.lan_addresses ?? []).filter(
    address => isNetworkAddress(address) && address !== status?.tailscale_ipv4
  ) : []

  const tailscale = lan && status?.tailscale_ipv4 && isNetworkAddress(status.tailscale_ipv4)
    ? status.tailscale_ipv4 : null

  const canPair = running && (lanAddresses.length > 0 || tailscale !== null)

  const addresses: { label: string; value: null | string }[] = [
    ...lanAddresses.map(address => ({
      label: 'On this network',
      value: `${address}:${port}`
    })),
    ...(tailscale
      ? [{ label: 'Tailscale', value: `${tailscale}:${port}` }]
      : []),
    {
      label: 'Hex Connect',
      value: status?.connect_hostname ? `https://${status.connect_hostname}` : null
    }
  ]

  return (
    <Frame
      actions={
        <Button data-primary onClick={() => void api.quit()} variant="primary">
          Done
        </Button>
      }
      aside={`${TRACK_NAME[result.receipt.channel]} ${result.receipt.version}`}
      mood="happy"
      subtitle={
        running
          ? 'Pair the Hexbot app on another device to start using it.'
          : tries >= STATUS_TRIES
            ? 'The daemon service is installed but has not started. Check hexbot service logs.'
            : 'The daemon service is starting.'
      }
      title={
        running
          ? `Hexbot Headless is ${job.kind === 'repair' ? 'up to date' : 'running'}`
          : `Hexbot Headless is ${job.kind === 'repair' ? 'up to date' : 'installed'}`
      }
    >
      <div className="grid grid-cols-[1fr_200px] gap-8">
        <div className="min-w-0">
          <h2 className="text-[length:var(--text-meta)] font-medium tracking-wide text-muted uppercase">
            Reach it at
          </h2>
          <ul className="mt-1.5 divide-y divide-border border-y border-border">
            {addresses.map(address => (
              <li className="flex h-10 items-center gap-3" key={`${address.label}${address.value}`}>
                <span className="w-[108px] shrink-0 text-muted">{address.label}</span>
                {address.value ? (
                  <>
                    <span className="selectable min-w-0 flex-1 truncate font-mono text-[length:var(--text-secondary)]">
                      {address.value}
                    </span>
                    <CopyButton label={address.label} text={address.value} />
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-muted">
                    Not set up. Run{' '}
                    <span className="font-mono text-foreground">hexbot connect</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <h2 className="mt-5 text-[length:var(--text-meta)] font-medium tracking-wide text-muted uppercase">
            From a terminal
          </h2>
          <ul className="mt-1.5 grid grid-cols-2 gap-x-4">
            {COMMANDS.map(([command, description]) => (
              <li className="flex items-center gap-1 py-1" key={command}>
                <span className="min-w-0 flex-1">
                  <span className="selectable block truncate font-mono text-[length:var(--text-secondary)]">
                    {command}
                  </span>
                  <span className="block truncate text-[length:var(--text-meta)] text-muted">
                    {description}
                  </span>
                </span>
                <CopyButton label={command} text={command} />
              </li>
            ))}
          </ul>
        </div>
        {canPair ? (
          <PairingPanel api={api} />
        ) : (
          <div className="rounded-panel bg-surface px-4 py-4 text-center">
            <p className="text-[length:var(--text-secondary)] text-muted">
              {!running
                ? 'The daemon service has not started. Check hexbot service logs.'
                : !lan
                  ? <>LAN access is off. Turn it on with{' '}
                    <span className="selectable font-mono text-foreground">hexbot lan on</span>{' '}
                    to pair over your network, or use Hex Connect.</>
                  : 'No network address found. Connect this computer to a network, or use Hex Connect.'}
            </p>
            {running && !lan ? <CopyButton label="hexbot lan on" text="hexbot lan on" /> : null}
          </div>
        )}
      </div>
      <Notes notes={notes} />
    </Frame>
  )
}

function pairingLifetime(expires: string): number {
  const match = /^(\d+(?:\.\d+)?)\s+(seconds?|minutes?)$/i.exec(expires.trim())

  return match ? Number(match[1]) * (/^minute/i.test(match[2]!) ? 60_000 : 1000) : 600_000
}

function PairingPanel({ api }: { api: InstallerApi }) {
  const [pairing, setPairing] = useState<null | (Pairing & { expiresAt: number })>(null)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!pairing) {return}

    const timer = setTimeout(() => {
      setPairing(null)
      setExpired(true)
    }, Math.max(0, pairing.expiresAt - Date.now()))

    return () => clearTimeout(timer)
  }, [pairing])

  const show = () => {
    setBusy(true)
    setError(null)
    api.showPairing().then(
      next => {
        setPairing({ ...next, expiresAt: Date.now() + pairingLifetime(next.expires) })
        setExpired(false)
        setBusy(false)
      },
      reason => {
        setError(friendlyError(errorMessage(reason)).message)
        setBusy(false)
      }
    )
  }

  return (
    <div className="flex flex-col items-center rounded-panel bg-surface px-4 py-4 text-center">
      {pairing ? (
        <>
          <PairingQr link={pairing.link} />
          <p
            aria-label="Pairing code"
            className="selectable mt-3 font-mono text-[20px] font-semibold tracking-[0.08em]"
          >
            {pairing.code}
          </p>
          <p className="mt-0.5 text-[length:var(--text-meta)] text-muted">
            Expires in {pairing.expires || '10 minutes'}
          </p>
          <Button
            className="mt-3 h-8 px-3 text-[length:var(--text-secondary)]"
            disabled={busy}
            onClick={show}
          >
            New code
          </Button>
        </>
      ) : (
        <>
          <p className="text-[length:var(--text-secondary)] text-muted">
            {expired ? 'This code expired.' : 'In the Hexbot app on another device, choose to pair with a daemon, then enter the code or scan it.'}
          </p>
          <Button className="mt-4" disabled={busy} onClick={show} variant="primary">
            {expired ? 'New code' : 'Show pairing code'}
          </Button>
        </>
      )}
      {error ? (
        <p className="selectable mt-3 text-[length:var(--text-secondary)] text-danger">{error}</p>
      ) : null}
    </div>
  )
}

function PairingQr({ link }: { link: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (canvas.current) {
      // Dark on light in both themes, so every camera reads it.
      void QRCode.toCanvas(canvas.current, link, {
        color: { dark: '#141414', light: '#ffffff' },
        margin: 2,
        width: 120
      })
    }
  }, [link])

  return <canvas aria-label="Pairing QR code" className="rounded-control" ref={canvas} role="img" />
}

export function Removed({
  detection,
  onQuit,
  removedData
}: {
  detection: Detection
  onQuit: () => void
  removedData: boolean
}) {
  const locations = detection.locations!

  return (
    <Frame
      actions={
        <Button data-primary onClick={onQuit} variant="primary">
          Quit
        </Button>
      }
      mood="sleeping"
      subtitle={
        removedData
          ? 'Your Hexbot data was deleted too.'
          : `Your Hexbot data is still in ${tildify(locations.hexbotHome, locations.home)}. Install Hexbot again to pick up where you left off.`
      }
      title="Hexbot is uninstalled"
    />
  )
}
