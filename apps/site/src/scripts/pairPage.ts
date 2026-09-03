import { parsePairLocation } from '../lib/pairLink'

const details = parsePairLocation(window.location)
const status = document.querySelector<HTMLElement>('#pair-status')
const panel = document.querySelector<HTMLElement>('#pair-details')
const code = document.querySelector<HTMLElement>('#pair-code')
const address = document.querySelector<HTMLElement>('#pair-address')
const open = document.querySelector<HTMLAnchorElement>('#pair-open')

if (details && status && panel && code && address && open) {
  status.hidden = true
  panel.classList.remove('hidden')
  code.textContent = details.code
  address.textContent = `${details.host}:${details.port}`
  open.href = details.deepLink
} else if (status) {
  status.textContent =
    'This pairing link is incomplete or has expired. Ask the daemon owner to run hexbot pair again.'
}
