// Send one message in a room through the UI and capture what happens. Usage: node scripts/dev/ui-room-chat.mjs <base> <roomId> "<text>" <out.png>
import { chromium } from 'playwright'
const [base, roomId, text, out] = process.argv.slice(2)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)))
await page.addInitScript(() => localStorage.setItem('hexbot.target', JSON.stringify({ kind: 'local' })))
await page.goto(`${base}/r/${roomId}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(2500)
const composer = page.getByTestId('room-composer')
await composer.fill(text); await composer.press('Enter')
for (let i = 0; i < 18; i++) { await page.waitForTimeout(5000); const body = (await page.evaluate(() => document.body.innerText)); if (/waiting on you|Waiting/i.test(body) && i > 3) break }
await page.screenshot({ path: out })
console.log((await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 900))
await browser.close()
