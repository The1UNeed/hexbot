// Print the error shown by the app's error boundary for a route. Usage: node scripts/dev/ui-error.mjs <base> <path>
import { chromium } from 'playwright'
const [base, path] = process.argv.slice(2)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 300)))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)) })
await page.addInitScript(() => localStorage.setItem('hexbot.target', JSON.stringify({ kind: 'local' })))
await page.goto(base + path, { waitUntil: 'networkidle' }); await page.waitForTimeout(3000)
const btn = page.getByText('Show Error'); if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(500) }
console.log((await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 900))
await browser.close()
