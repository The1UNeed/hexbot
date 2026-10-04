import { useEffect, useState } from 'react'

import type { Detection, InstallerApi, InstallOption, ManifestSummary, Track } from './api'
import { errorMessage } from './api'
import {
  changeNotice,
  formatSize,
  friendlyError,
  OPTION_NAME,
  OPTION_SUMMARY,
  optionItems,
  tildify,
  TRACK_NAME
} from './copy'
import { Button, Frame, Notice, Switch, TextButton } from './ui'

type Release =
  | { manifest: ManifestSummary; state: 'ready' }
  | { message: string; retry: boolean; state: 'error' }
  | { state: 'loading' }

/**
 * What an option installs and where. The release manifest is fetched here,
 * once the user has picked an option, and again when they switch tracks.
 */
export function OptionPage({
  api,
  detection,
  onBack,
  onInstall,
  option
}: {
  api: InstallerApi
  detection: Detection
  onBack: () => void
  onInstall: (track: Track) => void
  option: InstallOption
}) {
  const locations = detection.locations!
  const from = detection.installed?.option ?? null
  const changing = from !== null && from !== option
  const [track, setTrack] = useState<null | Track>(detection.installed?.track ?? null)
  const [release, setRelease] = useState<Release>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true

    setRelease({ state: 'loading' })

    const fetch = track
      ? api.fetchManifest(track)
      : api.defaultTrack().then(found => {
          if (live) {
            setTrack(found)
          }

          return null
        })

    fetch.then(
      manifest => {
        if (live && manifest) {
          setRelease({ manifest, state: 'ready' })
        }
      },
      error => {
        if (live) {
          const message = friendlyError(errorMessage(error)).message

          // A track with nothing published stays that way until the next release.
          setRelease({ message, retry: !message.startsWith('No '), state: 'error' })
        }
      }
    )

    return () => {
      live = false
    }
  }, [api, track, attempt])

  const offer = release.state === 'ready' ? release.manifest[option] : null
  const name = OPTION_NAME[option]
  const macos = detection.target?.startsWith('macos') ?? true
  const data = tildify(locations.hexbotHome, locations.home)

  return (
    <Frame
      actions={
        <>
          <Button onClick={onBack}>Back</Button>
          <Button
            data-primary
            disabled={!offer || !track}
            onClick={() => track && onInstall(track)}
            variant="primary"
          >
            {changing ? `Change to ${name}` : `Install ${name}`}
          </Button>
        </>
      }
      aside={
        <Switch
          checked={track === 'nightly'}
          disabled={!track}
          label="Nightly builds"
          onChange={nightly => setTrack(nightly ? 'nightly' : 'stable')}
        />
      }
      subtitle={OPTION_SUMMARY[option]}
      title={`Hexbot ${name}`}
    >
      <dl className="divide-y divide-border border-y border-border text-[length:var(--text-body)]">
        {optionItems(option, locations, macos).map(item => (
          <div className="flex items-baseline justify-between gap-6 py-2.5" key={item.label}>
            <dt>{item.label}</dt>
            <dd className="selectable shrink-0 font-mono text-[length:var(--text-secondary)] text-muted">
              {item.where}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-6 py-2.5">
          <dt>Download</dt>
          <dd className="shrink-0 text-muted" role="status">
            {release.state === 'loading' ? (
              'Checking the latest release'
            ) : release.state === 'error' ? (
              <span className="text-foreground">
                {release.message}
                {release.retry ? (
                  <>
                    {' '}
                    <TextButton onClick={() => setAttempt(value => value + 1)}>
                      Try again
                    </TextButton>
                  </>
                ) : null}
              </span>
            ) : offer ? (
              `${formatSize(offer.size)}${option === 'headless' ? ', then Python and voice tools' : ''}`
            ) : (
              <span className="text-foreground">Not available for this computer yet</span>
            )}
          </dd>
        </div>
        {release.state === 'ready' && offer ? (
          <div className="flex items-baseline justify-between gap-6 py-2.5">
            <dt>Release</dt>
            <dd className="selectable shrink-0 text-muted">
              {TRACK_NAME[release.manifest.track]} {release.manifest.version}
            </dd>
          </div>
        ) : null}
      </dl>
      {changing ? (
        <div className="mt-5">
          <Notice>{changeNotice(from, option, data)}</Notice>
        </div>
      ) : null}
    </Frame>
  )
}
