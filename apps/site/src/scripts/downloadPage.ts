// Start the download for this computer, then show what to do next. Without
// a script the page offers the Apple Silicon build and lists the rest.
import { detectTarget, type Target } from '../lib/detectPlatform'

const title = document.querySelector<HTMLElement>('#dl-title')
const sub = document.querySelector<HTMLElement>('#dl-sub')
const primary = document.querySelector<HTMLAnchorElement>('#dl-primary')
const label = document.querySelector<HTMLElement>('#dl-primary-label')

async function architecture(): Promise<string | undefined> {
  try {
    const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> } }).userAgentData
    return (await data?.getHighEntropyValues(['architecture']))?.architecture
  } catch {
    return undefined
  }
}

function renderer(): string | undefined {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : undefined
  } catch {
    return undefined
  }
}

function show(target: Target) {
  if (!title || !sub || !primary || !label) return
  const build = document.querySelector<HTMLAnchorElement>(`a[data-edition="full"][data-target="${target}"]`)
  if (target === 'other' || !build) {
    title.textContent = 'Hexbot runs on Mac and Linux.'
    sub.textContent = 'Download it on a Mac or a Linux computer. Then reach your bots from this device with a pairing link.'
    primary.hidden = true
    return
  }
  const name = build.dataset.name ?? ''
  primary.href = build.href
  for (const steps of document.querySelectorAll<HTMLElement>('[data-os]'))
    steps.hidden = steps.dataset.os !== (target === 'linux' ? 'linux' : 'mac')
  title.textContent = 'Thanks for downloading Hexbot'
  sub.textContent = `Your download for ${name} should begin automatically.`
  label.textContent = 'Download again'
  // The file is served as a download, so the page stays put. A click, not
  // location.assign, so analytics.ts counts it as an automatic download.
  setTimeout(() => {
    primary.dataset.trigger = 'auto'
    primary.click()
    delete primary.dataset.trigger
  }, 600)
}

if (primary) architecture().then(arch => show(detectTarget({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, architecture: arch, renderer: renderer() })))
