import { describe, expect, it, vi } from 'vitest'

import { applicationMenuTemplate } from './application-menu'

describe('applicationMenuTemplate', () => {
  it.each(['win32', 'linux'] as const)('offers File > Quit without a tray on %s', platform => {
    const actions = { checkForUpdates: vi.fn(), openSettings: vi.fn(), quit: vi.fn() }
    const menu = applicationMenuTemplate(actions, 'Hexbot', platform)
    expect(menu[0]!.label).toBe('File')
    const items = menu[0]!.submenu as import('electron').MenuItemConstructorOptions[]
    expect(items.find(item => item.role === 'quit')!.click).toBe(actions.quit)
  })

  it('has the native macOS application, edit, and window menus', () => {
    const template = applicationMenuTemplate(
      {
        checkForUpdates: vi.fn(),
        openSettings: vi.fn(),
        quit: vi.fn()
      },
      'Hexbot',
      'darwin'
    )
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
