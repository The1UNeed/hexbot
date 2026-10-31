// Name the platform on the landing page's download buttons. A label marked
// data-download-label="nightly" says so, because nightly is all there is.
// On an iPhone or iPad the buttons go to the TestFlight beta instead.
import { detectTarget } from '../lib/detectPlatform'
import { testflightUrl } from '../lib/downloads'

const target = detectTarget({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints })
const platform = target === 'linux' ? ' for Linux' : target === 'other' ? '' : ' for Mac'
for (const label of document.querySelectorAll<HTMLElement>('[data-download-label]')) {
  if (target === 'ios') {
    label.textContent = 'Get the iPhone beta'
    label.closest('a')?.setAttribute('href', testflightUrl)
    continue
  }
  label.textContent = `Download${label.dataset.downloadLabel === 'nightly' ? ' nightly' : ''}${platform}`
}
