// Screenshot one route of the served web UI. Usage: node scripts/dev/ui-shot.mjs <base> <path> <out.png>
import { chromium } from 'playwright'
const [base, path, out] = process.argv.slice(2)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
await page.addInitScript(() => localStorage.setItem('hexbot.target', JSON.stringify({ kind: 'local' })))
await page.goto(base + path, { waitUntil: 'networkidle' }); await page.waitForTimeout(3500)
await page.screenshot({ path: out })
console.log((await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 300))
await browser.close()
