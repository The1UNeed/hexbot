import { _electron as electron, expect, test } from '@playwright/test'
import electronExecutable from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedCodexTokens, startDaemon, type RunningDaemon } from './daemon'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '../..')

test('creates a bot, chats, and creates another section', async () => {
  const daemonHome = await mkdtemp(resolve(tmpdir(), 'hexbot-e2e-daemon-'))
  const desktopHome = await mkdtemp(resolve(tmpdir(), 'hexbot-e2e-desktop-'))
  let daemon: RunningDaemon | undefined
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined

  try {
    await seedCodexTokens(repoRoot, daemonHome)
    daemon = await startDaemon(repoRoot, daemonHome)
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [resolve(desktopRoot, 'out/main/index.js')],
      env: {
        ...process.env,
        HEXBOT_E2E_TARGET: `http://127.0.0.1:${daemon.port}`,
        HEXBOT_HOME: desktopHome
      }
    })

    const page = await app.firstWindow()
    await expect(page.getByTestId('root-connection-status')).toHaveAttribute(
      'data-connection-state',
      'connected',
      { timeout: 30_000 }
    )
    await page.getByTestId('onboarding-provider-item-openai-codex').click()
    await expect(page.getByTestId('onboarding-continue')).toBeEnabled()
    await page.getByTestId('onboarding-continue').click()

    await page.getByTestId('onboarding-bot-display-input').fill('Scout')
    await page.getByTestId('onboarding-bot-name-input').fill('scout')
    await page.getByLabel('Model').click()
    await page.getByRole('option', { exact: true, name: 'gpt-5.6-sol' }).click()
    await page.getByTestId('onboarding-create-button').click()

    const composer = page.locator('#conversation-composer')
    await expect(composer).toBeEnabled({ timeout: 30_000 })
    await composer.fill('Reply with exactly the word: pong')
    await composer.press('Enter')
    await expect(page.getByTestId('bot-message').filter({ hasText: /pong/i }).last()).toBeVisible({
      timeout: 120_000
    })

    const firstSectionUrl = page.url()
    await page.getByRole('button', { name: 'New', exact: true }).click()
    const newSection = page.getByTestId('roster-new-section')
    await expect(newSection).toBeVisible()
    await newSection.click()
    await expect(page).not.toHaveURL(firstSectionUrl, { timeout: 30_000 })
    await expect(page.locator('[data-roster-id^="section:"]')).toHaveCount(2)
  } finally {
    await app?.close().catch(() => undefined)
    await daemon?.stop().catch(() => undefined)
    await Promise.all([
      rm(daemonHome, { force: true, recursive: true }),
      rm(desktopHome, { force: true, recursive: true })
    ])
  }
})
