// Name the platform on the landing page's download buttons.
import { detectTarget } from '../lib/detectPlatform'

const target = detectTarget({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints })
const text = target === 'linux' ? 'Download for Linux' : target === 'other' ? 'Download' : 'Download for Mac'
for (const label of document.querySelectorAll<HTMLElement>('[data-download-label]')) label.textContent = text
