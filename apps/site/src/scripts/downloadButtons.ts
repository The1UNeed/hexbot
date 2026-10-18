// Name the platform on the landing page's download buttons. A label marked
// data-download-label="nightly" says so, because nightly is all there is.
import { detectTarget } from '../lib/detectPlatform'

const target = detectTarget({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints })
const platform = target === 'linux' ? ' for Linux' : target === 'windows' ? ' for Windows' : target === 'other' ? '' : ' for Mac'
for (const label of document.querySelectorAll<HTMLElement>('[data-download-label]')) {
  const available: string[] = JSON.parse(label.dataset.downloadTargets ?? '[]')
  label.textContent = `Download${label.dataset.downloadLabel === 'nightly' ? ' nightly' : ''}${available.includes(target) ? platform : ''}`
}
