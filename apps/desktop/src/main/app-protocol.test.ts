import { describe, expect, it } from 'vitest'
import { resolveAppRequest } from './app-protocol'

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
