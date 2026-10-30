// Third-party notices for what each Hexbot package ships: the Rust crates
// linked into a binary, the npm packages bundled into a script or installed
// beside one, and the programs the daemon runtime carries. Each entry names
// the package, its license and its source, then the license and notice files
// the package itself ships. Hexbot's own license is LICENSE, and NOTICE
// credits the projects Hexbot's source came from.
//
//   node scripts/desktop/third-party-notices.mjs app|installer|installer-app|web [--out FILE]
//   node scripts/desktop/third-party-notices.mjs mobile [--check]
//
// The daemon runtime's notices are written by native-runtime.mjs, the web
// bundle's by apps/web/vite.config.ts, and the Electron app's by its build. The mobile app's are committed, since
// EAS builds it from the repository; `--check` fails when they are stale.
import { execFile } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const licenses = join(root, 'scripts/desktop/licenses')
const maxBuffer = 256 * 1024 * 1024
/** Every target a package is built for, including Linux arm64 Headless. */
export const RUST_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']
export const MOBILE_NOTICES = join(root, 'apps/mobile/third-party-notices.json')
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|unlicense|copyright)(?:[-._].*)?$/i
/** Standard texts kept in scripts/desktop/licenses/spdx, for packages that ship no license file. */
const STANDARD = ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', 'MPL-2.0']

/** Registry crates a manifest's binaries link on any of `targets`; build scripts and proc macros never ship. */
export async function cargoPackages(manifest, { targets = RUST_TARGETS, run = execute } = {}) {
  const found = new Map()
  for (const target of targets) {
    const { stdout } = await run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', target, '--manifest-path', manifest], { maxBuffer })
    const metadata = JSON.parse(stdout)
    const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]))
    const packages = new Map(metadata.packages.map(item => [item.id, item]))
    const linked = new Set()
    const queue = [...metadata.workspace_members]
    while (queue.length) {
      const id = queue.pop()
      const item = packages.get(id)
      if (linked.has(id) || item.targets.some(target => target.kind.includes('proc-macro'))) continue
      linked.add(id)
      for (const dependency of nodes.get(id).deps)
        if (dependency.dep_kinds.some(kind => kind.kind === null)) queue.push(dependency.pkg)
    }
    for (const id of linked) {
      const item = packages.get(id)
      if (!item.source) continue // Hexbot's own crates
      found.set(`${item.name}@${item.version}`, {
        name: item.name,
        version: item.version,
        license: item.license ?? '',
        authors: item.authors,
        source: item.source.startsWith('registry+') ? `https://crates.io/crates/${item.name}/${item.version}` : item.repository ?? item.source,
        directory: dirname(item.manifest_path),
        files: item.license_file ? [item.license_file] : []
      })
    }
  }
  return [...found.values()]
}

async function npmPackage(directory) {
  const json = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const license = typeof json.license === 'string' ? json.license
    : json.license?.type ?? (json.licenses ?? []).map(item => item.type ?? item).join(' OR ')
  const author = typeof json.author === 'string' ? json.author : json.author?.name
  return {
    name: json.name,
    version: json.version,
    license: license ?? '',
    authors: author ? [author] : [],
    source: `https://www.npmjs.com/package/${json.name}/v/${json.version}`,
    directory,
    files: [],
    platform: Boolean(json.os || json.cpu)
  }
}

/**
 * Production npm packages of a workspace app, which its bundler draws from.
 * Packages for one operating system or CPU are native build tools, never part
 * of a script bundle, and differ between the machines that list them.
 */
export async function pnpmPackages(app, { repository = root, run = execute } = {}) {
  const { stdout } = await run('pnpm', ['--filter', `./${app}`, 'licenses', 'list', '--prod', '--json'], { cwd: repository, maxBuffer })
  const found = new Map()
  for (const entries of Object.values(JSON.parse(stdout)))
    for (const entry of entries)
      for (const directory of entry.paths) {
        if (!directory.includes(`${sep}node_modules${sep}`)) continue // Hexbot's own workspace packages
        const item = await npmPackage(directory)
        if (!item.platform) found.set(`${item.name}@${item.version}`, item)
      }
  return [...found.values()]
}

/** Every package installed under a node_modules directory, as it ships. */
export async function installedPackages(nodeModules) {
  const found = new Map()
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const child = join(directory, entry.name)
      if (entry.name.startsWith('@')) { await visit(child); continue }
      const item = await npmPackage(child).catch(() => null)
      if (item) found.set(`${item.name}@${item.version}`, item)
      await visit(join(child, 'node_modules'))
    }
  }
  await visit(nodeModules)
  return [...found.values()]
}

async function shippedFiles(item, shared) {
  const names = (await readdir(item.directory)).filter(name => LICENSE_FILE.test(name))
  const texts = []
  for (const name of [...new Set([...names, ...item.files])].sort()) {
    const path = join(item.directory, name)
    if (!(await stat(path).catch(() => null))?.isFile()) continue
    texts.push(await shareStandard(normalize(await readFile(path, 'utf8')), shared))
  }
  return texts
}

const normalize = text => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
const collapse = text => text.replace(/\s+/g, ' ').trim()
const standard = id => readFile(join(licenses, 'spdx', `${id}.txt`), 'utf8').then(normalize)
/** Where a long license's own terms sit in a file; anything around them, such as a copyright line, stays. */
const SPANS = {
  'Apache-2.0': [/^[ \t]*TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION$/m, /^[ \t]*END OF TERMS AND CONDITIONS$/m],
  'MPL-2.0': [/^Mozilla Public License,? Version 2\.0$/m, /defined by the Mozilla Public License, v\. 2\.0\.$/m]
}
const span = (text, [start, end]) => {
  const from = text.search(start)
  const match = from < 0 ? null : end.exec(text.slice(from))
  return match ? [from, from + match.index + match[0].length] : null
}
const sharedNote = id => `[The ${id} terms. They are printed once, under ${id}, at the start of these notices.]`

/** Apache-2.0 and MPL-2.0 terms are printed once; a package's copy of them points there. */
async function shareStandard(text, shared) {
  for (const id of Object.keys(SPANS)) {
    const found = span(text, SPANS[id])
    if (!found) continue
    const terms = await standard(id)
    const canonical = span(terms, SPANS[id])
    if (collapse(text.slice(...found)) !== collapse(terms.slice(...canonical))) continue
    shared.add(id)
    text = `${text.slice(0, found[0])}${sharedNote(id)}${text.slice(found[1])}`.trim()
  }
  return text
}
const holders = authors => authors.map(author => author.replace(/\s*<[^>]*>\s*/g, '').trim()).filter(Boolean).join(', ')

/** A package without license files gets the standard text of its license, naming the authors it lists. */
async function standardText(item, shared) {
  const ids = item.license.replace(/[()]/g, ' ').split(/\s+|\//).filter(id => id && !['AND', 'OR', 'WITH'].includes(id))
  const chosen = /\bAND\b/.test(item.license) ? ids : [STANDARD.find(id => ids.includes(id)) ?? ids[0]]
  const holder = holders(item.authors) || `the ${item.name} authors`
  const texts = [`${item.name} ships no license file. Its license is ${item.license}; the standard text follows, naming the authors the package lists.`]
  for (const id of chosen) {
    if (!STANDARD.includes(id)) throw new Error(`${item.name} ${item.version} ships no license file and Hexbot keeps no standard text for ${id || 'its license'}`)
    texts.push(await shareStandard((await standard(id)).replace('<copyright holders>', holder), shared))
  }
  return texts
}

/**
 * The license texts of each package, packages with the same texts together,
 * in a stable order, and the long standard licenses their texts point to.
 */
export async function noticeEntries(packages, extras = []) {
  const groups = new Map()
  const shared = new Set()
  const add = (text, item) => {
    const group = groups.get(text) ?? groups.set(text, []).get(text)
    group.push({ name: item.name, version: item.version, license: item.license, source: item.source })
  }
  for (const item of packages) {
    const texts = await shippedFiles(item, shared)
    add((texts.length ? texts : await standardText(item, shared)).join('\n\n'), item)
  }
  for (const extra of extras) add(await shareStandard(normalize(extra.text), shared), extra)
  // Code-point order, the same on every machine.
  const key = item => `${item.name}\u0000${item.version}`
  const order = (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
  const entries = [...groups]
    .map(([text, items]) => ({ packages: items.sort(order), text }))
    .sort((a, b) => order(a.packages[0], b.packages[0]))
  const licenses = []
  for (const id of Object.keys(SPANS)) if (shared.has(id)) licenses.push({ id, text: await standard(id) })
  return { licenses, entries }
}

const RULE = '='.repeat(80)
export function renderNotices(title, { licenses, entries }) {
  const intro = `${title} includes the third-party software below. Each entry names the packages, their licenses and where their source code is, followed by the license and notice text they ship with. Hexbot's own license is in LICENSE, and NOTICE credits the projects Hexbot's source came from.`
  const standards = licenses.map(license => [RULE, license.id, '-'.repeat(80), license.text].join('\n'))
  const body = entries.map(entry => [
    RULE,
    ...entry.packages.map(item => `${item.name} ${item.version} (${item.license || 'see below'}) ${item.source}`),
    '-'.repeat(80),
    entry.text
  ].join('\n'))
  return `THIRD-PARTY NOTICES\n\n${wrap(intro)}\n\n${[...standards, ...body].join('\n\n')}\n`
}

function wrap(text, width = 80) {
  const lines = ['']
  for (const word of text.split(' ')) {
    if (lines.at(-1) && lines.at(-1).length + word.length + 1 > width) lines.push('')
    lines[lines.length - 1] += `${lines.at(-1) ? ' ' : ''}${word}`
  }
  return lines.join('\n')
}

/** A program the daemon runtime carries, with the license files kept for its pinned version. */
export async function toolNotice(name, version, license, source) {
  const directory = join(licenses, `${name}-${version}`)
  const files = (await readdir(directory).catch(() => {
    throw new Error(`No license files for ${name} ${version}; add them to ${relative(root, directory)}`)
  })).sort()
  const texts = await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))
  return { name, version, license, source, text: texts.map(normalize).join('\n\n') }
}

/**
 * The daemon runtime: the Rust daemon, the Pi packages installed beside it,
 * Node, and the search tools. Its web app carries its own notices.
 */
export async function runtimeNotices({ repository = root, nodeModules, targets = RUST_TARGETS, node }) {
  const tools = JSON.parse(await readFile(join(repository, 'backend/hexbot-core/assets/code-tools.json'), 'utf8'))
  const extras = [
    { name: 'Node.js', version: node.version, license: 'MIT', source: `https://github.com/nodejs/node/tree/v${node.version}`, text: node.license },
    await toolNotice('rg', tools.rg.version, 'MIT OR Unlicense', `https://github.com/BurntSushi/ripgrep/tree/${tools.rg.version}`),
    await toolNotice('fd', tools.fd.version, 'MIT OR Apache-2.0', `https://github.com/sharkdp/fd/tree/v${tools.fd.version}`)
  ]
  const packages = [
    ...await cargoPackages(join(repository, 'backend/hexbot-core/Cargo.toml'), { targets }),
    ...await installedPackages(nodeModules)
  ]
  return renderNotices('The Hexbot daemon runtime', await noticeEntries(packages, extras))
}

/** The Electron app: its main process packages and the web app it shows. */
export async function appNotices({ repository = root } = {}) {
  const packages = [...await pnpmPackages('apps/desktop', { repository }), ...await pnpmPackages('apps/web', { repository })]
  return renderNotices('The Hexbot app', await noticeEntries(packages))
}

export async function webNotices({ repository = root } = {}) {
  return renderNotices('The Hexbot web app', await noticeEntries(await pnpmPackages('apps/web', { repository })))
}

export async function installerNotices({ repository = root } = {}) {
  return renderNotices('hexbot-install', await noticeEntries(await cargoPackages(join(repository, 'backend/hexbot-installer/Cargo.toml'))))
}

export async function installerAppNotices({ repository = root } = {}) {
  const packages = [
    ...await cargoPackages(join(repository, 'apps/installer/src-tauri/Cargo.toml')),
    ...await pnpmPackages('apps/installer', { repository })
  ]
  return renderNotices('Hexbot Installer', await noticeEntries(packages))
}

export async function mobileNotices({ repository = root } = {}) {
  return `${JSON.stringify(await noticeEntries(await pnpmPackages('apps/mobile', { repository })), null, 1)}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [artifact, ...rest] = process.argv.slice(2)
  const build = { app: appNotices, web: webNotices, installer: installerNotices, 'installer-app': installerAppNotices, mobile: mobileNotices }[artifact]
  if (!build) {
    console.error('Usage: node scripts/desktop/third-party-notices.mjs app|installer|installer-app|web [--out FILE] | mobile [--check]')
    process.exit(2)
  }
  const text = await build()
  const out = rest.includes('--out') ? resolve(rest[rest.indexOf('--out') + 1]) : artifact === 'mobile' ? MOBILE_NOTICES : null
  if (rest.includes('--check')) {
    if ((await readFile(out, 'utf8').catch(() => '')) !== text) {
      console.error(`${relative(root, out)} is out of date. Run: node scripts/desktop/third-party-notices.mjs ${artifact}`)
      process.exit(1)
    }
  } else if (out) await writeFile(out, text)
  else process.stdout.write(text)
}
