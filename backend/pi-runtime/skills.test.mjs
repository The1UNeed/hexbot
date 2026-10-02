import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = new URL('../../', import.meta.url);
for (const [file, directory] of [
  ['skills/research/competitor-news-monitor/SKILL.md','competitor-watches'],
  ['skills/productivity/product-price-monitor/SKILL.md','price-watches'],
  ['optional-skills/software-development/code-wiki/SKILL.md','wikis'],
  ['optional-skills/research/darwinian-evolver/SKILL.md','darwinian-evolver'],
  ['optional-skills/productivity/memento-flashcards/SKILL.md','memento-data'],
  ['skills/productivity/box/references/cli-guide.md','tools/box-cli'],
  ['skills/autonomous-ai-agents/hermes-agent/references/themes.md','hexbot-setup/skins'],
  ['skills/autonomous-ai-agents/hermes-agent/references/tui-widgets.md','hexbot-setup/tui-widgets'],
  ['skills/autonomous-ai-agents/hermes-agent/references/contributor-guide.md','hexbot-setup/plugins'],
  ['optional-skills/security/godmode/SKILL.md','hexbot-setup/prefill.json'],
]) test(`${directory} output stays in the section workspace`, () => {
  const text = readFileSync(new URL(file,root),'utf8');
  assert.ok(text.includes(`./${directory}`));
  assert.ok(!text.includes(`~/.hexbot/${directory}`));
  assert.ok(!text.includes(`$HOME/.hexbot/${directory}`));
});

test('flashcard storage uses the current workspace', t => {
  const cwd = mkdtempSync(join(tmpdir(),'hexbot-cards-'));
  t.after(() => rmSync(cwd,{recursive:true,force:true}));
  const script = fileURLToPath(new URL('optional-skills/productivity/memento-flashcards/scripts/memento_cards.py',root));
  execFileSync('python3',[script,'add','--question','Fixture?','--answer','Yes','--collection','Tests'], {cwd,env:{PATH:process.env.PATH,HOME:cwd,HERMES_HOME:join(cwd,'must-not-write')}});
  assert.ok(existsSync(join(cwd,'memento-data/cards.json')));
  assert.ok(!existsSync(join(cwd,'must-not-write')));
});
