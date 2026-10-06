import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { currentFingerprints, fingerprint, generateHistory, repository } from './skill-history.mjs'

test('committed skill history contains every current bundled fingerprint', () => {
  const history = JSON.parse(readFileSync(join(repository, 'skills/.history.json'), 'utf8'))
  for (const [name, hash] of Object.entries(currentFingerprints(join(repository, 'skills')))) {
    assert.ok(history[name]?.includes(hash), `${name} changed; run node scripts/desktop/skill-history.mjs`)
  }
  for (const hashes of Object.values(history)) {
    assert.ok(hashes.length > 0)
    assert.deepEqual(hashes, [...new Set(hashes)].sort())
    for (const hash of hashes) assert.match(hash, /^[0-9a-f]{64}$/)
  }
})

test('fingerprint ignores dotfiles and non-executable permissions, but includes paths, bytes and execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'hexbot-fingerprint-'))
  try {
    writeFileSync(join(root, 'SKILL.md'), 'body')
    chmodSync(join(root, 'SKILL.md'), 0o644)
    const original = fingerprint(root)
    // Shared test vector with Rust, independent of creation order and directory entries.
    assert.equal(original, '58689cdc43326993f597c831b4497c78b5af37e37d42f59796bcba1a489d91e4')
    writeFileSync(join(root, 'a.txt'), 'sibling')
    mkdirSync(join(root, 'a'))
    writeFileSync(join(root, 'a/b'), 'nested')
    assert.equal(fingerprint(root), '9ffb1ec9d346ae7a634e29f97b901607127543b617ea843d9e3623dafa919f8e')
    rmSync(join(root, 'a'), { recursive: true })
    rmSync(join(root, 'a.txt'))
    writeFileSync(join(root, '.note'), 'private')
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, '.hidden/file'), 'hidden')
    mkdirSync(join(root, 'empty'))
    chmodSync(join(root, 'SKILL.md'), 0o600)
    assert.equal(fingerprint(root), original)
    chmodSync(join(root, 'SKILL.md'), 0o700)
    assert.notEqual(fingerprint(root), original)
    chmodSync(join(root, 'SKILL.md'), 0o600)
    writeFileSync(join(root, 'extra'), 'body')
    assert.notEqual(fingerprint(root), original)
    rmSync(join(root, 'extra'))
    writeFileSync(join(root, 'SKILL.md'), 'changed')
    assert.notEqual(fingerprint(root), original)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('history includes each Git version and the uncommitted tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'hexbot-skill-git-'))
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  try {
    git(['init'])
    git(['config', 'user.name', 'Fixture'])
    git(['config', 'user.email', 'fixture@example.invalid'])
    const skill = join(root, 'skills/work/notes')
    mkdirSync(skill, { recursive: true })
    const hashes = []
    for (const body of ['first', 'second']) {
      writeFileSync(join(skill, 'SKILL.md'), body)
      hashes.push(fingerprint(skill))
      git(['add', 'skills'])
      git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', body])
    }
    writeFileSync(join(skill, 'SKILL.md'), 'working tree')
    hashes.push(fingerprint(skill))
    assert.deepEqual(generateHistory(root), { notes: hashes.sort() })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
