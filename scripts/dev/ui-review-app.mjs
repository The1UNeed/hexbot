import { chromium } from 'playwright'
const [base, bot, section] = [process.argv[2], process.argv[3], process.argv[4]]
const browser = await chromium.launch()
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, colorScheme: scheme })
  page.on('pageerror', e => console.log('PAGEERROR', e.message))
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 240)) })
  await page.addInitScript(({ bot, section }) => {
    localStorage.setItem('hexbot.target', JSON.stringify({ kind: 'local' }))
  }, { bot, section })
  await page.goto(`${base}/b/${bot}/s/${section}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(3500)
  await page.screenshot({ path: `/tmp/hexbot-shots/10-app-${scheme}.png` })
  console.log(scheme, 'BODY:', (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 400))
  if (scheme === 'light') {
    const input = page.locator('textarea').first()
    if (await input.count()) { await input.fill('Reply with exactly the word: pong'); await input.press('Enter'); await page.waitForTimeout(25000); await page.screenshot({ path: `/tmp/hexbot-shots/11-app-reply.png` }); console.log('AFTER:', (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 500)) }
    await page.goto(`${base}/settings/network`, { waitUntil: 'networkidle' }); await page.waitForTimeout(2500); await page.screenshot({ path: `/tmp/hexbot-shots/12-settings-network.png` })
  }
  await page.close()
}
await browser.close()
