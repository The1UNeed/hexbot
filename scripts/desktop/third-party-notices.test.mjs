import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cargoPackages, installedPackages, noticeEntries, renderNotices, toolNotice } from './third-party-notices.mjs'

const apache = readFile(new URL('../../LICENSE', import.meta.url), 'utf8')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-notices-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pkg = async (name, files, extra = {}) => {
    const directory = join(root, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }))
    for (const [file, text] of Object.entries(files)) await writeFile(join(directory, file), text)
    return directory
  }
  return { root, pkg }
}

test('packages with the same license files share an entry; files are kept as shipped', async t => {
  const { root, pkg } = await fixture(t)
  await pkg('b', { LICENSE: 'MIT License\r\n\r\nCopyright (c) Same  \n' }, { license: 'MIT' })
  await pkg('a', { 'LICENSE.md': 'MIT License\n\nCopyright (c) Same\n', README: 'not a license' }, { license: 'MIT' })
  await pkg('c', { 'LICENSE-MIT': 'Copyright (c) C', NOTICE: 'C notice' }, { license: 'MIT OR Apache-2.0' })
  const { licenses, entries } = await noticeEntries(await installedPackages(join(root, 'node_modules')))
  assert.deepEqual(licenses, [])
  assert.deepEqual(entries.map(entry => [entry.packages.map(item => item.name), entry.text]), [
    [['a', 'b'], 'MIT License\n\nCopyright (c) Same'],
    [['c'], 'Copyright (c) C\n\nC notice']
  ])
  assert.equal(entries[0].packages[0].source, 'https://www.npmjs.com/package/a/v/1.0.0')
})

test('a package without license files gets its standard text, naming its authors', async t => {
  const { root, pkg } = await fixture(t)
  await pkg('bare', {}, { license: '(MIT OR Apache-2.0)', author: { name: 'Ada Lovelace', email: 'ada@example.com' } })
  const { entries } = await noticeEntries(await installedPackages(join(root, 'node_modules')))
  assert.match(entries[0].text, /^bare ships no license file\. Its license is \(MIT OR Apache-2\.0\)/)
  assert.match(entries[0].text, /\nCopyright \(c\) Ada Lovelace\n/)
  assert.match(entries[0].text, /Permission is hereby granted, free of charge/)
})

test('Apache-2.0 terms print once; each copy keeps its own lines around them', async t => {
  const { root, pkg } = await fixture(t)
  const terms = (await apache).replace('Copyright [yyyy] [name of copyright owner]', 'Copyright 2024 Someone')
  await pkg('one', { 'LICENSE-APACHE': terms }, { license: 'Apache-2.0' })
  await pkg('two', {}, { license: 'Apache-2.0', author: 'Two' })
  const notices = await noticeEntries(await installedPackages(join(root, 'node_modules')))
  assert.deepEqual(notices.licenses.map(license => license.id), ['Apache-2.0'])
  for (const entry of notices.entries) {
    assert.doesNotMatch(entry.text, /TERMS AND CONDITIONS FOR USE/)
    assert.match(entry.text, /\[The Apache-2\.0 terms\. They are printed once/)
  }
  assert.match(notices.entries[0].text, /Copyright 2024 Someone/)
  const text = renderNotices('Fixture', notices)
  assert.equal(text.match(/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/g).length, 1)
  assert.match(text, /^THIRD-PARTY NOTICES\n\nFixture includes the third-party software below\./)
  assert.ok(text.indexOf('\nApache-2.0\n') < text.indexOf('\none 1.0.0 (Apache-2.0)'))
})

test('a package with no license file and no standard text stops the build', async t => {
  const { root, pkg } = await fixture(t)
  await pkg('odd', {}, { license: 'WTFPL' })
  await assert.rejects(noticeEntries(await installedPackages(join(root, 'node_modules'))), /odd 1\.0\.0 ships no license file/)
})

test('crates come from every target, without build scripts, proc macros or Hexbot crates', async t => {
  const { root } = await fixture(t)
  const crate = name => join(root, name)
  for (const name of ['linked', 'mac-only', 'macro', 'macro-dep', 'build-dep']) {
    await mkdir(crate(name), { recursive: true })
    await writeFile(join(crate(name), 'LICENSE'), `${name} license`)
  }
  const item = (name, kind = 'lib') => ({
    id: name, name, version: '1.0.0', license: 'MIT', authors: [], source: name === 'hexbot' ? null : 'registry+https://github.com/rust-lang/crates.io-index',
    manifest_path: join(crate(name), 'Cargo.toml'), targets: [{ kind: [kind] }]
  })
  const dep = (pkg, kind = null) => ({ pkg, dep_kinds: [{ kind }] })
  const metadata = target => ({
    workspace_members: ['hexbot'],
    packages: [item('hexbot'), item('linked'), item('mac-only'), item('macro', 'proc-macro'), item('macro-dep'), item('build-dep')],
    resolve: {
      nodes: [
        { id: 'hexbot', deps: [dep('linked'), dep('macro'), dep('build-dep', 'build'), ...(target.includes('apple') ? [dep('mac-only')] : [])] },
        { id: 'linked', deps: [] }, { id: 'mac-only', deps: [] }, { id: 'macro', deps: [dep('macro-dep')] }, { id: 'macro-dep', deps: [] }, { id: 'build-dep', deps: [] }
      ]
    }
  })
  const run = async (command, args) => ({ stdout: JSON.stringify(metadata(args[args.indexOf('--filter-platform') + 1])) })
  const crates = await cargoPackages('Cargo.toml', { targets: ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'], run })
  assert.deepEqual(crates.map(item => item.name).sort(), ['linked', 'mac-only'])
  assert.equal(crates[0].source, `https://crates.io/crates/${crates[0].name}/1.0.0`)
})

test('the runtime tools have license files for their pinned versions', async () => {
  const tools = JSON.parse(await readFile(new URL('../../backend/hexbot-core/assets/code-tools.json', import.meta.url), 'utf8'))
  for (const tool of ['rg', 'fd']) {
    const notice = await toolNotice(tool, tools[tool].version, 'MIT', 'source')
    assert.match(notice.text, /Permission is hereby granted/)
  }
  const kept = await readdir(new URL('./licenses', import.meta.url))
  assert.deepEqual(kept.filter(name => name !== 'spdx').sort(), [`fd-${tools.fd.version}`, `rg-${tools.rg.version}`])
})
