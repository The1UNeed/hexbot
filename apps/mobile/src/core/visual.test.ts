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
