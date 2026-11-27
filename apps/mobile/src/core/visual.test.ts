import { expect, it } from 'vitest'
import { visualDocument } from './visual'
it('installs the visual policy before bot content and rejects CSS injection into the theme', () => {
  const document = visualDocument('<script>fetch("https://daemon")</script>', {
    '--background': '#fff',
    '--foreground': '</style><script>bad</script>'
  })
  expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('fetch('))
  expect(document).toContain('connect-src data: blob:')
  expect(document).toContain("form-action 'none'")
  expect(document).not.toContain('bad')
})
it('puts the theme and the page defaults ahead of the page, so its own CSS wins', () => {
  const document = visualDocument('<!DOCTYPE html><html><head><style>body{padding:0}</style></head><body><p>Hi</p></body></html>', {
    '--background': '#1c1c1e'
  })
  expect(document.startsWith('<!doctype html>')).toBe(true)
  expect(document.match(/<!doctype/gi)).toHaveLength(1)
  expect(document).toContain(':root{--background:#1c1c1e}')
  expect(document).toContain('body{margin:0;padding:16px}')
  expect(document.indexOf('padding:16px')).toBeLessThan(document.indexOf('body{padding:0}'))
  // The page is not nested in a body of ours.
  expect(document).not.toMatch(/<body>\s*<html>/)
})
