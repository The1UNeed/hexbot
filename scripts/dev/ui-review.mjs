// Drive the served web UI for a visual review. Usage: node scripts/dev/ui-review.mjs http://127.0.0.1:9134
import { chromium } from 'playwright'
const base = process.argv[2] || 'http://127.0.0.1:9134'
const shots = '/tmp/hexbot-shots'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, colorScheme: 'light' })
page.on('pageerror', e => console.log('PAGEERROR', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 240)) })
const snap = async name => { await page.screenshot({ path: `${shots}/${name}.png` }); console.log('shot', name, page.url()) }
const body = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 500)
const ids = async () => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')).join(','))
await page.addInitScript(() => { if (!localStorage.getItem('hexbot.target')) localStorage.setItem('hexbot.target', JSON.stringify({ kind: 'local' })) })
await page.goto(base + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(3000)
await snap('02-after-seed'); console.log('BODY:', await body()); console.log('IDS:', await ids())

// Walk onboarding adaptively.
const step = async (name, action) => { try { await action() } catch (e) { console.log('STEP FAIL', name, e.message.slice(0, 160)) } await page.waitForTimeout(1500); await snap(name); console.log('BODY:', await body()); console.log('IDS:', await ids()) }
await step('03-choice', async () => { await page.getByText('Connect to a Hexbot daemon', { exact: false }).first().click() })
await step('04-next', async () => { const b = page.getByRole('button', { name: /continue|next|skip|already|use/i }).first(); if (await b.count()) await b.click() })
await browser.close()
