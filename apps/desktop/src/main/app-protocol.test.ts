import { describe, expect, it } from 'vitest'
import { appResponseHeaders, frameNavigationAllowed, resolveAppRequest } from './app-protocol'

const root = '/bundle'
const files = new Set(['/bundle/index.html', '/bundle/assets/app.js', '/bundle/assets/app.css'])
const exists = (file: string) => files.has(file)

describe('resolveAppRequest', () => {
  it('serves existing assets with their mime type', () => {
    expect(resolveAppRequest('/assets/app.js', root, exists)).toEqual({
      file: '/bundle/assets/app.js',
      mime: 'text/javascript; charset=utf-8'
    })
  })
  it('falls back to index.html for nested routes', () => {
    expect(resolveAppRequest('/b/scout/s/abc', root, exists).file).toBe('/bundle/index.html')
  })
  it('falls back to index.html for missing assets and never escapes the root', () => {
    expect(resolveAppRequest('/../../etc/passwd', root, exists).file).toBe('/bundle/index.html')
    expect(resolveAppRequest('/assets/missing.js', root, exists).file).toBe('/bundle/index.html')
  })
})

describe('appResponseHeaders', () => {
  it('gives app pages the app policy and leaves the visual frame its own', () => {
    expect(
      appResponseHeaders('/bundle/index.html', 'text/html; charset=utf-8', root)[
        'content-security-policy'
      ]
    ).toContain("script-src 'self'")
    expect(
      appResponseHeaders('/bundle/visual-frame.html', 'text/html; charset=utf-8', root)
    ).not.toHaveProperty('content-security-policy')
    expect(
      appResponseHeaders('/bundle/assets/app.js', 'text/javascript; charset=utf-8', root)
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
