import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appResponseHeaders, frameNavigationAllowed, resolveAppRequest } from './app-protocol'

const root = resolve('bundle')
const files = new Set(['index.html', 'assets/app.js', 'assets/app.css'].map(file => join(root, file)))
const exists = (file: string) => files.has(file)

describe('resolveAppRequest', () => {
  it('serves existing assets with their mime type', () => {
    expect(resolveAppRequest('/assets/app.js', root, exists)).toEqual({
      file: join(root, 'assets/app.js'),
      mime: 'text/javascript; charset=utf-8'
    })
  })
  it('falls back to index.html for nested routes', () => {
    expect(resolveAppRequest('/b/scout/s/abc', root, exists).file).toBe(join(root, 'index.html'))
  })
  it('falls back to index.html for missing assets and never escapes the root', () => {
    expect(resolveAppRequest('/../../etc/passwd', root, exists).file).toBe(join(root, 'index.html'))
    expect(resolveAppRequest('/assets/missing.js', root, exists).file).toBe(join(root, 'index.html'))
  })
})

describe('appResponseHeaders', () => {
  it('gives app pages the app policy and leaves the visual frame its own', () => {
    expect(
      appResponseHeaders(join(root, 'index.html'), 'text/html; charset=utf-8', root)[
        'content-security-policy'
      ]
    ).toContain("script-src 'self'")
    expect(
      appResponseHeaders(join(root, 'visual-frame.html'), 'text/html; charset=utf-8', root)
    ).not.toHaveProperty('content-security-policy')
    expect(
      appResponseHeaders(join(root, 'assets/app.js'), 'text/javascript; charset=utf-8', root)
    ).not.toHaveProperty('content-security-policy')
  })
})

describe('frameNavigationAllowed', () => {
  it('lets frames load only the visual frame from the app origin', () => {
    expect(
      frameNavigationAllowed('hexbot-app://app/visual-frame.html', 'hexbot-app://app/b/owl')
    ).toBe(true)
    expect(
      frameNavigationAllowed('http://localhost:5173/visual-frame.html', 'http://localhost:5173/')
    ).toBe(true)
    expect(
      frameNavigationAllowed('https://example.com/?data=secret', 'hexbot-app://app/b/owl')
    ).toBe(false)
    expect(frameNavigationAllowed('hexbot-app://app/', 'hexbot-app://app/b/owl')).toBe(false)
    expect(frameNavigationAllowed('not a url', 'hexbot-app://app/')).toBe(false)
    expect(frameNavigationAllowed('hexbot-app://evil/visual-frame.html', 'hexbot-app://app/')).toBe(
      false
    )
    expect(frameNavigationAllowed('file:///visual-frame.html', 'hexbot-app://app/')).toBe(false)
    expect(
      frameNavigationAllowed('http://localhost:5174/visual-frame.html', 'http://localhost:5173/')
    ).toBe(false)
  })
})
