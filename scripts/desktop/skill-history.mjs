// Regenerate after editing bundled skills: node scripts/desktop/skill-history.mjs
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sorted = values => values.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
const entries = dir => sorted(readdirSync(dir).filter(name => !name.startsWith('.')))

// For each sorted relative POSIX path: path + NUL + executable (0/1) + NUL +
// decimal byte length + NUL + bytes. Empty directories and dotfiles are ignored.
export function fingerprint(dir) {
  const files = []
  function walk(path) {
    for (const name of entries(path)) {
      const file = join(path, name)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error(`Skill contains symlink: ${file}`)
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile()) files.push(relative(dir, file).split(sep).join('/'))
      else throw new Error(`Skill contains special file: ${file}`)
    }
  }
  walk(dir)
  const hash = createHash('sha256')
  for (const file of sorted(files)) {
    const path = join(dir, file)
    const bytes = readFileSync(path)
    hash.update(`${file}\0${lstatSync(path).mode & 0o111 ? 1 : 0}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

export function currentFingerprints(root) {
  const result = {}
  function walk(path) {
    const names = entries(path)
    if (path !== root && names.includes('SKILL.md')) {
      const name = basename(path)
      if (result[name]) throw new Error(`Duplicate bundled skill: ${name}`)
      result[name] = fingerprint(path)
      return
    }
    for (const name of names) {
      const child = join(path, name)
      if (lstatSync(child).isDirectory()) walk(child)
    }
  }
  walk(root)
  return result
}

export function generateHistory(repo = repository) {
  const git = args => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 128 * 1024 * 1024 })
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true') {
    throw new Error('Fetch full git history before regenerating skill history')
  }
  const history = new Map()
  const add = root => {
    for (const [name, hash] of Object.entries(currentFingerprints(root))) {
      if (!history.has(name)) history.set(name, new Set())
      history.get(name).add(hash)
    }
  }
  const commits = git(['log', '--format=%H', '--', 'skills']).toString().trim().split('\n').filter(Boolean)
  for (const commit of commits) {
    const temp = mkdtempSync(join(tmpdir(), 'hexbot-skill-history-'))
    try {
      execFileSync('tar', ['-xf', '-', '-C', temp], { input: git(['archive', commit, 'skills']) })
      add(join(temp, 'skills'))
    } finally { rmSync(temp, { recursive: true, force: true }) }
  }
  add(join(repo, 'skills'))
  return Object.fromEntries(sorted([...history.keys()]).map(name => [name, sorted([...history.get(name)])]))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = generateHistory()
  const text = JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(join(repository, 'skills/.history.json'), text)
  console.log(`${Object.keys(manifest).length} skills, ${Object.values(manifest).flat().length} fingerprints, ${Buffer.byteLength(text)} bytes`)
}
