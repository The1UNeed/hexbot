import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/windows-security.yml', import.meta.url), 'utf8');
for (const event of ['push', 'pull_request']) test(`${event} runs Windows refusal checks for build and boundary inputs`, () => {
  const section = workflow.match(new RegExp(`^  ${event}:\\r?\\n([\\s\\S]*?)(?=^  [a-z_]+:|^[a-z_]+:)`, 'm'))?.[1];
  assert(section, `Missing ${event} trigger`);
  const paths = section.match(/    paths:\r?\n((?:      (?:- |#).*\r?\n)+)/)?.[1];
  assert(paths, `Missing ${event} path filters`);
  const patterns = [...paths.matchAll(/^      - ['"]([^'"]+)['"]\r?$/gm)].map(match => match[1]);
  const triggers = path => patterns.some(pattern => posix.matchesGlob(path, pattern));
  for (const path of [
    'backend/hexbot-core/Cargo.toml', 'backend/hexbot-core/Cargo.lock',
    'backend/hexbot-core/src/native_tools.rs', 'backend/hexbot-core/src/future_boundary.rs',
    'backend/hexbot-core/tests/windows_security.rs',
    'rust-toolchain.toml', 'rust-toolchain', '.cargo/config.toml', '.cargo/config',
    'backend/pi-runtime/credential-policy.json', 'backend/pi-runtime/package-lock.json',
    'scripts/dev/prepare-windows-security.mjs', 'scripts/dev/windows-security-inputs.mjs',
    'scripts/dev/windows-security-standard-user.ps1', '.github/workflows/windows-security.yml',
  ]) assert(triggers(path), `${event} skips ${path}`);
  assert(!triggers('apps/site/src/pages/index.astro'), 'Unrelated site edits need no native refusal job');
});
