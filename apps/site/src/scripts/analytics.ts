// PostHog, loaded only after the visitor accepts the cookie notice. It sends
// page views, autocaptured clicks, Core Web Vitals, uncaught errors, and
// session recordings (inputs masked) through the /ingest rewrite in
// vercel.json, plus a `download` event for every build link: edition, os,
// arch, format, version, channel, and trigger ('auto' when the download page
// starts it, 'click' otherwise). A download made before the visitor answers
// is sent if they accept on the same page. Connect (apps/connect) reports to
// the same project under the same consent key, so one dashboard covers both.
//
// `choice` is the one source of truth. PostHog starts opted out and sync()
// brings it in line whenever it finishes loading or the choice changes, here
// or in another tab.
import type { PostHog } from 'posthog-js'
import { describeDownload, type DownloadInfo } from '../lib/downloadInfo'

type Choice = 'granted' | 'denied'
type Download = DownloadInfo & { trigger: 'auto' | 'click' }

const storageKey = 'hexbot-analytics'
const banner = document.querySelector<HTMLElement>('#consent')
const state = document.querySelector<HTMLElement>('#consent-state')
const pending: Download[] = []
let choice = parse(read())
let posthog: Promise<PostHog> | undefined

function parse(value: string | null): Choice | null {
  return value === 'granted' || value === 'denied' ? value : null
}

function read(): string | null {
  try { return localStorage.getItem(storageKey) } catch { return null }
}

function sync(ph: PostHog) {
  if (choice !== 'granted') {
    ph.opt_out_capturing() // also removes the cookie
    return
  }
  if (!ph.has_opted_in_capturing()) ph.opt_in_capturing({ captureEventName: null })
  for (const download of pending.splice(0)) ph.capture('download', download)
}

function load() {
  posthog ??= import('posthog-js').then(({ default: ph }) => {
    ph.init(import.meta.env.PUBLIC_POSTHOG_KEY, {
      api_host: '/ingest',
      ui_host: 'https://us.posthog.com',
      defaults: '2026-08-30',
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      // Consent and the visitor id stay on this host; Connect keeps its own.
      cross_subdomain_cookie: false,
      // PostHog's own consent record can say opted in before sync() runs.
      before_send: event => (choice === 'granted' ? event : null),
      // Already the default; pinned because the privacy page promises it and
      // an init option overrides the project's masking setting.
      session_recording: { maskAllInputs: true },
      // What Vercel Speed Insights used to measure, in the same project as everything else.
      capture_performance: { web_vitals: true },
      capture_exceptions: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
    })
    return ph
  })
  posthog.then(sync, () => { posthog = undefined }) // a failed load can be retried
}

function apply(next: Choice) {
  choice = next
  if (banner) banner.hidden = true
  if (next === 'granted') load()
  else {
    pending.length = 0
    if (posthog) load()
  }
}

function decide(next: Choice) {
  try { localStorage.setItem(storageKey, next) } catch {}
  apply(next)
}

function onDownloadClick(event: MouseEvent) {
  const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[download]')
  const info = link && describeDownload(link.href)
  if (!info || choice === 'denied') return
  pending.push({ ...info, trigger: link.dataset.trigger === 'auto' ? 'auto' : 'click' })
  if (choice === 'granted') load()
}

document.addEventListener('click', onDownloadClick)
document.addEventListener('auxclick', onDownloadClick) // middle-click opens the file in a new tab
window.addEventListener('storage', event => {
  const next = event.key === storageKey && parse(event.newValue)
  if (next) apply(next)
})

for (const button of document.querySelectorAll<HTMLElement>('[data-consent]'))
  button.addEventListener('click', () => decide(button.dataset.consent as Choice))
for (const button of document.querySelectorAll<HTMLElement>('[data-consent-open]'))
  button.addEventListener('click', () => {
    if (!banner) return
    if (state) {
      state.textContent = choice === 'granted' ? 'You accepted.' : choice === 'denied' ? 'You declined.' : ''
      state.hidden = !choice
    }
    banner.hidden = false
  })

if (choice === 'granted') load()
else if (choice === null && banner) banner.hidden = false
