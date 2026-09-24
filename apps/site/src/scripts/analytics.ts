// PostHog, loaded only after the visitor accepts the cookie notice. It sends
// page views, autocaptured clicks, and session recordings (inputs masked)
// through the /ingest rewrite in vercel.json, plus a `download` event for
// every build link: edition, os, arch, format, version, channel, and trigger
// ('auto' when the download page starts it, 'click' otherwise). A download
// made before the visitor answers is sent if they accept on the same page.
import type { PostHog } from 'posthog-js'
import { describeDownload, type DownloadInfo } from '../lib/downloadInfo'

type Choice = 'granted' | 'denied'
type Download = DownloadInfo & { trigger: 'auto' | 'click' }

const storageKey = 'hexbot-analytics'
const banner = document.querySelector<HTMLElement>('#consent')
const pending: Download[] = []
let posthog: Promise<PostHog> | undefined

function stored(): Choice | null {
  try {
    const value = localStorage.getItem(storageKey)
    return value === 'granted' || value === 'denied' ? value : null
  } catch {
    return null
  }
}

function load(): Promise<PostHog> {
  return (posthog ??= import('posthog-js').then(({ default: ph }) => {
    ph.init(import.meta.env.PUBLIC_POSTHOG_KEY, {
      api_host: '/ingest',
      ui_host: 'https://us.posthog.com',
      defaults: '2026-08-30',
      person_profiles: 'identified_only',
      // Declining later removes the cookie as well as stopping capture.
      opt_out_persistence_by_default: true,
      session_recording: { maskAllInputs: true },
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
    })
    return ph
  }))
}

function decide(choice: Choice) {
  try { localStorage.setItem(storageKey, choice) } catch {}
  if (banner) banner.hidden = true
  if (choice === 'granted') {
    load().then(ph => {
      ph.opt_in_capturing() // clears an earlier opt-out
      for (const download of pending.splice(0)) ph.capture('download', download)
    })
  } else {
    pending.length = 0
    posthog?.then(ph => ph.opt_out_capturing())
  }
}

document.addEventListener('click', event => {
  const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[download]')
  const info = link && describeDownload(link.href)
  if (!info) return
  const download: Download = { ...info, trigger: event.isTrusted ? 'click' : 'auto' }
  const choice = stored()
  if (choice === 'granted') load().then(ph => ph.capture('download', download))
  else if (choice === null) pending.push(download)
})

for (const button of document.querySelectorAll<HTMLElement>('[data-consent]'))
  button.addEventListener('click', () => decide(button.dataset.consent as Choice))
for (const button of document.querySelectorAll<HTMLElement>('[data-consent-open]'))
  button.addEventListener('click', () => { if (banner) banner.hidden = false })

const choice = stored()
if (choice === 'granted') load()
else if (choice === null && banner) banner.hidden = false
