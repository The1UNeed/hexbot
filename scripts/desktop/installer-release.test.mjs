import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)

test('windowed installer release step handles bundle names with spaces on every target', async t => {
  const source = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const step = source.match(/- name: Build the windowed installer\n([\s\S]*?)(?=      - name:)/)?.[1]
  assert.ok(step)
  assert.match(step, /if: runner.os != 'Windows' && hashFiles\('apps\/installer\/package.json'\) != ''/)
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-installer-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'))
  await mkdir(join(root, 'installer-artifacts'))
  await writeFile(join(root, 'bin/pnpm'), `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path'; fs.mkdirSync(path.dirname(process.env.BUNDLE_PATH), { recursive: true }); fs.writeFileSync(process.env.BUNDLE_PATH, 'bundle'); fs.writeFileSync('arguments.json', JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 })
  const version = '0.1.5-nightly.20261003.42'
  for (const [target, suffix, bundles] of [
    ['aarch64-apple-darwin', 'mac-arm64.dmg', 'dmg'],
    ['x86_64-apple-darwin', 'mac-x64.dmg', 'dmg'],
    ['x86_64-unknown-linux-gnu', 'linux-x86_64.AppImage', 'appimage']
  ]) {
    const extension = suffix.split('.').at(-1)
    const bundle = join(root, 'apps/installer/src-tauri/target', target, 'release/bundle', bundles, `Hexbot Installer.${extension}`)
    const substituted = script.replaceAll('${{ matrix.rust-target }}', target)
      .replaceAll('${{ matrix.app-suffix }}', suffix).replaceAll('${{ matrix.bundles }}', bundles)
    const options = { cwd: root, env: { ...process.env, VERSION: version, RUNNER_TEMP: '/runner temp', BUNDLE_PATH: bundle, PATH: `${join(root, 'bin')}:${process.env.PATH}` } }
    await run('bash', ['-c', substituted], options)
    assert.equal(await readFile(join(root, 'installer-artifacts', `HexbotInstaller-${version}-${suffix}`), 'utf8'), 'bundle')
    const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'))
    assert.deepEqual(args.slice(0, 5), ['--filter', './apps/installer', 'run', 'tauri', 'build'])
    assert.equal(args[args.indexOf('--target') + 1], target)
    // Tauri merges the config: the notices join LICENSE and NOTICE.
    assert.deepEqual(JSON.parse(args[args.indexOf('--config') + 1]), {
      version, bundle: { resources: { '/runner temp/installer-app-notices.txt': 'THIRD_PARTY_NOTICES' } }
    })
    await writeFile(join(dirname(bundle), `Other.${extension}`), 'ambiguous')
    await assert.rejects(run('bash', ['-c', substituted], options), /Expected exactly one windowed installer bundle/)
  }
})

test('installer signing falls back to ad-hoc when the certificate password is missing', async t => {
  const source = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const step = [...source.matchAll(/- name: Prepare macOS signing\n([\s\S]*?)(?=      - name:)/g)].map(match => match[1]).find(step => step.includes('APPLE_SIGNING_IDENTITY'))
  assert.ok(step)
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-installer-signing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const envFile = join(root, 'env')
  const { stdout } = await run('bash', ['-c', script], {
    env: { ...process.env, CSC_LINK: 'fixture-certificate', CSC_KEY_PASSWORD: '', GITHUB_ENV: envFile, RUNNER_TEMP: root }
  })
  assert.match(stdout, /::notice::.*ad-hoc signed/)
  assert.equal(await readFile(envFile, 'utf8'), 'APPLE_SIGNING_IDENTITY=-\n')
})

test('release builds both installers with third-party notices', async () => {
  const source = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const notices = source.match(/- name: Write the installers' third-party notices\n([\s\S]*?)(?=      - name:)/)?.[1]
  assert.match(notices, /third-party-notices\.mjs installer --out "\$RUNNER_TEMP\/hexbot-install-notices\.txt"/)
  assert.match(notices, /third-party-notices\.mjs installer-app --out "\$RUNNER_TEMP\/installer-app-notices\.txt"/)
  const cli = source.match(/- name: Build the CLI installer\n([\s\S]*?)(?=      - name:)/)?.[1]
  assert.match(cli, /HEXBOT_THIRD_PARTY_NOTICES="\$RUNNER_TEMP\/hexbot-install-notices\.txt" cargo build --release/)
})

test('Windows CLI installer preserves its exe suffix and skips Tauri', async t => {
  const source = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const installer = source.split('  installer:\n')[1].split('  publish:\n')[0]
  assert.match(installer, /rust-target: x86_64-pc-windows-msvc\n            target: windows-x86_64\n            exe-suffix: \.exe/)
  assert.match(installer, /defaults:\n      run:\n        shell: bash/)
  const step = installer.match(/- name: Build the CLI installer\n([\s\S]*?)(?=      - name:)/)?.[1]
  assert.ok(step)
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '')
    .replaceAll('${{ matrix.rust-target }}', 'x86_64-pc-windows-msvc')
    .replaceAll('${{ matrix.target }}', 'windows-x86_64')
    .replaceAll('${{ matrix.exe-suffix }}', '.exe')
  const root = await mkdtemp(join(tmpdir(), 'hexbot-windows-installer-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/cargo'), `#!${process.execPath}\nimport fs from 'node:fs'; const dir='backend/hexbot-installer/target/x86_64-pc-windows-msvc/release'; fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(dir+'/hexbot-install.exe','engine');\n`, { mode: 0o755 })
  await run('bash', ['-c', script], { cwd: root, env: { ...process.env, VERSION: '1.2.3', RUNNER_TEMP: root, PATH: `${join(root, 'bin')}:${process.env.PATH}` } })
  assert.equal(await readFile(join(root, 'installer-artifacts/hexbot-install-1.2.3-windows-x86_64.exe'), 'utf8'), 'engine')
  const tauri = installer.match(/- name: Build the windowed installer\n([\s\S]*?)(?=      - name:)/)?.[1]
  assert.match(tauri, /if: runner.os != 'Windows'/)
})
