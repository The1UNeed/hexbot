// Fresh-browser walkthrough of onboarding and first chat. Usage: node scripts/dev/ui-review.mjs http://127.0.0.1:9134
import { chromium } from 'playwright'
const base = process.argv[2] || 'http://127.0.0.1:9134'
const shots = '/tmp/hexbot-shots'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, colorScheme: 'light' })
page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 200)))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)) })
const snap = async name => { await page.screenshot({ path: `${shots}/${name}.png` }); console.log('shot', name, page.url()) }
const body = async () => (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 420)
const ids = async () => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')).join(','))
const step = async (name, action) => { try { await action() } catch (e) { console.log('STEP FAIL', name, e.message.slice(0, 160)) } await page.waitForTimeout(1500); await snap(name); console.log('BODY:', await body()); console.log('IDS:', await ids()) }
await page.goto(base + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(3000)
await step('20-boot', async () => {})
await step('21-provider', async () => { await page.getByTestId('onboarding-provider-item-openai-codex').click() })
await step('22-continue', async () => { await page.getByTestId('onboarding-continue').click() })
await step('23-bot', async () => { await page.getByTestId('onboarding-bot-display-input').fill('Writer'); await page.waitForTimeout(300) })
await step('24-create', async () => { await page.getByTestId('onboarding-create-button').click(); await page.waitForTimeout(4000) })
await step('25-send', async () => { const t = page.locator('#conversation-composer'); await t.fill('Reply with exactly the word: pong'); await t.press('Enter'); await page.waitForTimeout(30000) })
await browser.close()
