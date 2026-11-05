// Name the platform on the landing page's download buttons. A label marked
// data-download-label="nightly" says so, because nightly is all there is.
// On an iPhone or iPad the buttons go to the TestFlight beta instead.
import { detectTarget } from '../lib/detectPlatform'
import { testflightUrl } from '../lib/downloads'

async function labelDownloads() {
  let hints: { architecture?: string; bitness?: string } | undefined
  try {
    const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string; bitness?: string }> } }).userAgentData
    hints = await data?.getHighEntropyValues(['architecture', 'bitness'])
  } catch { /* Use the user agent when hints are unavailable. */ }
  const target = detectTarget({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, ...hints })
  const platform = target === 'linux' ? ' for Linux' : target === 'win-x64' ? ' for Windows x64' : target === 'other' ? '' : ' for Mac'
  for (const label of document.querySelectorAll<HTMLElement>('[data-download-label]')) {
    if (target === 'ios') {
      label.textContent = 'Get the iPhone beta'
      label.closest('a')?.setAttribute('href', testflightUrl)
      continue
    }
    label.textContent = `Download${label.dataset.downloadLabel === 'nightly' ? ' nightly' : ''}${platform}`
  }
}
void labelDownloads()
