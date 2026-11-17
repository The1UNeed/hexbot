import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../skills/', import.meta.url));
const texts = (dir) => readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return texts(path);
  return /\.(md|py|sh|txt)$/.test(entry.name) ? [path] : [];
});

// A bot's tools never write Hexbot's own state; output stays in the section workspace.
test('no bundled skill writes into the Hexbot home', () => {
  const files = texts(root);
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const home of ['~/.hexbot/', '$HOME/.hexbot/', '${HERMES_HOME', '$HEXBOT_HOME/']) {
      assert.ok(!text.includes(home), `${file.slice(root.length)} names ${home}`);
    }
  }
});
