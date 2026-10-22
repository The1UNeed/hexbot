/* global window, document, Image, MutationObserver, requestAnimationFrame */
// Real browser checks for original faces. Uses a temporary Vite entry, removed on exit.
// Run: node apps/web/scripts/face-smoke.mjs
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const web = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const artifacts = process.env.HEXBOT_FACE_ARTIFACTS || await mkdtemp(path.join(tmpdir(), 'hexbot-faces-'))
await mkdir(artifacts, { recursive: true })
process.chdir(web)
const fixture = `.face-smoke-${process.pid}.html`
const fixturePath = path.join(web, fixture)
let browser, server
const errors = []
try {
  await writeFile(fixturePath, `<!doctype html><html><head><meta charset="utf-8"><title>Hexbot original faces</title></head><body><div id="root"></div>
<script type="module">
import '/src/styles/tokens.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Avatar, LiveFace } from '/src/components/ui/avatar.tsx'
import * as avatars from '/src/lib/avatar-builder.ts'
import { FACE_MOODS } from '/src/lib/face.ts'
import { HEXBOT_ACT_NAMES } from '/src/components/ui/hexbot-act.tsx'
const h = React.createElement
const root = createRoot(document.getElementById('root'))
const render = children => flushSync(() => root.render(children))
const style = { color: 'pink', shape: 'hexagon' }
window.faces = {
  ...avatars, moods: FACE_MOODS,
  show: props => render(h(LiveFace, { color: '#ec2f8a', eyes: '#ffffff', ...props })),
  roster: (names, act) => render(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(8, 72px)', gap: 24 } }, names.map(name => h(Avatar, { key: name, name, act, size: 'xl', mood: 'working', style })))),
  acts: () => render(h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 48, padding: 40 } }, HEXBOT_ACT_NAMES.map(act => h(Avatar, { key: act, name: act, act, size: 'xl', style })))),
  empty: () => render(null),
  gallery: () => render(h('main', { style: { padding: 48, maxWidth: 1150, margin: 'auto' } },
    h('h1', { style: { fontSize: 28, fontWeight: 600, marginBottom: 12 } }, 'Hexbot faces'),
    h('p', { style: { marginBottom: 40 } }, 'Original outlines and capsule eyes. Expressions follow the work.'),
    h('div', { style: { display: 'flex', gap: 36, marginBottom: 48 } }, FACE_MOODS.map(mood => h('div', { key: mood, style: { textAlign: 'center' } }, h(Avatar, { name: mood, mood, size: 'xl', style }), h('p', { style: { marginTop: 12 } }, mood)))),
    h('div', { style: { display: 'flex', gap: 42, marginBottom: 48 } }, avatars.AVATAR_SHAPES.map(shape => h('div', { key: shape.id, style: { textAlign: 'center' } }, h(Avatar, { name: shape.label, size: 'xl', style: { color: 'teal', shape: shape.id } }), h('p', { style: { marginTop: 12 } }, shape.label)))),
    h('div', { style: { display: 'flex', gap: 20 } }, avatars.AVATAR_COLORS.map(color => h(Avatar, { key: color.id, name: color.label, size: 'lg', style: { color: color.id, shape: 'hexagon' } })))
  ))
}
window.faces.gallery()
</script></body></html>`)
  server = await createServer({ root: web, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${fixture}`)
  await page.waitForFunction(() => Boolean(window.faces))
  await page.screenshot({ path: path.join(artifacts, 'original-faces-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: path.join(artifacts, 'original-faces-dark.png') })

  // Actual canvas rasterisation and readback, all 8 shapes x 11 colours x 2 formats.
  const roundtrips = await page.evaluate(async () => {
    const f = window.faces
    const failures = []
    let count = 0
    for (const shape of f.AVATAR_SHAPES) {
      for (const color of f.AVATAR_COLORS) {
        const style = { color: color.id, shape: shape.id }
        const png = await f.avatarPng(style)
        if (JSON.stringify(await f.readFace(png)) !== JSON.stringify(style)) failures.push({ format: 'current', style })
        // Original flat eyes from avatar-builder.ts before f1582cad, same outlines.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="' + shape.path + '" fill="' + color.value + '"/><ellipse cx="41" cy="48" rx="3.6" ry="6.2" fill="#151517"/><ellipse cx="59" cy="48" rx="3.6" ry="6.2" fill="#151517"/></svg>'
        const image = new Image()
        image.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 512
        canvas.getContext('2d').drawImage(image, 0, 0, 512, 512)
        if (JSON.stringify(await f.readFace(canvas.toDataURL('image/png'))) !== JSON.stringify(style)) failures.push({ format: 'legacy', style })
        count += 2
      }
    }
    return { count, failures }
  })
  assert.deepEqual(roundtrips.failures, [])

  await page.evaluate(() => window.faces.show({ mood: 'idle' }))
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  const quiet = await page.evaluate(async () => {
    let mutations = 0, frames = 0
    const original = window.requestAnimationFrame
    window.requestAnimationFrame = (...args) => { frames++; return original(...args) }
    const observer = new MutationObserver(records => { mutations += records.length })
    observer.observe(document.querySelector('svg'), { attributes: true, childList: true, subtree: true })
    await new Promise(resolve => setTimeout(resolve, 350))
    observer.disconnect()
    window.requestAnimationFrame = original
    return { mutations, frames }
  })
  assert.deepEqual(quiet, { mutations: 0, frames: 0 })

  await page.evaluate(() => window.faces.show({ mood: 'working' }))
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(1)
  await page.evaluate(() => { document.getElementById('root').style.marginTop = '2000px' })
  await expect(page.locator('svg')).toHaveAttribute('data-moving', 'false')
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0)
  await page.evaluate(() => { document.getElementById('root').style.marginTop = '0' })
  await expect(page.locator('svg')).toHaveAttribute('data-moving', 'true')
  await page.evaluate(() => window.faces.show({ mood: 'working', still: true }))
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const mood of await page.evaluate(() => window.faces.moods)) {
    await page.evaluate(mood => window.faces.show({ mood, shape: 'triangle', color: '#ececf0', eyes: '#151517', look: 'left' }), mood)
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0)
    await expect(page.locator('svg > path')).toHaveAttribute('fill', '#ececf0')
    await expect(page.locator('rect').first()).toHaveAttribute('fill', '#151517')
    assert.equal(await page.locator('[transform="translate(-10 -2)"]').count(), 1)
    const drawn = await page.locator('svg').innerHTML()
    await page.waitForTimeout(80)
    assert.equal(await page.locator('svg').innerHTML(), drawn)
  }
  await page.evaluate(() => window.faces.acts())
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'Every act settles under reduced motion')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  await page.evaluate(() => {
    window.faces.roster(['Scout', 'Builder'], 'juggle')
    window.scout = document.querySelector('[aria-label="Scout"]')
  })
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0)
  await page.evaluate(() => window.faces.roster(['Builder', 'Scout'], 'juggle'))
  assert.equal(await page.evaluate(() => window.scout === document.querySelector('[aria-label="Scout"]')), true)
  await page.evaluate(() => window.faces.empty())
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0)
  assert.equal(await page.locator('svg').count(), 0)

  // Twenty-four working faces, 4x CPU throttling. CSS produces no SVG attribute writes.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.evaluate(() => window.faces.roster(Array.from({ length: 24 }, (_, n) => 'Bot ' + n)))
  await expect(page.locator('svg[data-moving="true"]')).toHaveCount(24)
  const performance = await page.evaluate(async () => {
    let mutations = 0
    const observer = new MutationObserver(records => { mutations += records.length })
    for (const svg of document.querySelectorAll('svg')) observer.observe(svg, { attributes: true, subtree: true })
    const intervals = []
    let previous = await new Promise(resolve => requestAnimationFrame(resolve))
    for (let i = 0; i < 60; i++) {
      const next = await new Promise(resolve => requestAnimationFrame(resolve))
      intervals.push(next - previous)
      previous = next
    }
    observer.disconnect()
    intervals.sort((a, b) => a - b)
    return { mutations, medianFrameMs: intervals[30], p95FrameMs: intervals[57] }
  })
  assert.equal(performance.mutations, 0)
  assert(performance.p95FrameMs < 50, JSON.stringify(performance))
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, roundtrips: roundtrips.count, quiet, performance, artifacts }, null, 2))
} finally {
  await browser?.close()
  await server?.close()
  await rm(fixturePath, { force: true })
}
