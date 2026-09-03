import { describe, expect, it, vi } from 'vitest'

import { applicationMenuTemplate } from './application-menu'

describe('applicationMenuTemplate', () => {
  it('has the native macOS application, edit, and window menus', () => {
    const template = applicationMenuTemplate({
      checkForUpdates: vi.fn(),
      openSettings: vi.fn(),
      quit: vi.fn()
    })
    expect(JSON.parse(JSON.stringify(template))).toMatchInlineSnapshot(`
      [
        {
          "label": "Hexbot",
          "submenu": [
            {
              "role": "about",
            },
            {
              "type": "separator",
            },
            {
              "accelerator": "CommandOrControl+,",
              "label": "Settings…",
            },
            {
              "label": "Check for Updates…",
            },
            {
              "type": "separator",
            },
            {
              "role": "quit",
            },
          ],
        },
        {
          "role": "editMenu",
        },
        {
          "role": "windowMenu",
        },
      ]
    `)
  })
})
