// Start the download for this computer, then show what to do next: the Hexbot
// Installer when one is published for it, the full package otherwise. Without
// a script the page offers the first build and lists the rest.
import type { DownloadChoice } from '../lib/downloadChoices'
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
  const builds: DownloadChoice[] = JSON.parse(primary.dataset.builds ?? '[]')
  const build = builds.find(build => build.key === target)
  if (target === 'other' || !build) {
    title.textContent = 'Hexbot runs on Mac and Linux.'
    sub.textContent = document.querySelector('#dl-terminal')
      ? 'Install it on a Mac or a Linux computer, or on a server with the terminal command below. Then reach your bots from this device with a pairing link.'
      : 'Download it on a Mac or a Linux computer. Then reach your bots from this device with a pairing link.'
    primary.hidden = true
    return
  }
  const name = build.name
  const kind = build.kind
  const os = target === 'linux' ? 'linux' : 'mac'
  primary.href = build.url
  for (const element of document.querySelectorAll<HTMLElement>('[data-os], [data-for]'))
    element.hidden = (!!element.dataset.os && element.dataset.os !== os) || (!!element.dataset.for && element.dataset.for !== kind)
  title.textContent = 'Thanks for downloading Hexbot'
  sub.textContent = kind === 'installer'
    ? `The Hexbot Installer for ${name} should begin downloading.`
    : `Your download for ${name} should begin automatically.`
  label.textContent = 'Download again'
  // The file is served as a download, so the page stays put. A click, not
  // location.assign, so analytics.ts counts it as an automatic download.
  setTimeout(() => {
    primary.dataset.trigger = 'auto'
    primary.click()
    delete primary.dataset.trigger
  }, 600)
}

// Copy buttons start hidden, so without a script the command is plain selectable text.
for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  const status = button.querySelector('span') ?? button
  if (!navigator.clipboard) continue
  button.hidden = false
  let reset: ReturnType<typeof setTimeout> | undefined
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '')
      status.textContent = 'Copied'
    } catch {
      status.textContent = 'Select and copy'
    }
    clearTimeout(reset)
    reset = setTimeout(() => { status.textContent = 'Copy' }, 2000)
  })
}

if (primary) architecture().then(arch => show(detectTarget({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, architecture: arch, renderer: renderer() })))
