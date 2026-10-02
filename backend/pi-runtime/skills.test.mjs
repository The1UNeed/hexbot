import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

const root = new URL('../../', import.meta.url);
for (const [file, directory] of [
  ['skills/research/competitor-news-monitor/SKILL.md','competitor-watches'],
  ['skills/productivity/product-price-monitor/SKILL.md','price-watches'],
  ['skills/productivity/box/references/cli-guide.md','tools/box-cli'],
  ['skills/autonomous-ai-agents/hermes-agent/references/themes.md','hexbot-setup/skins'],
  ['skills/autonomous-ai-agents/hermes-agent/references/tui-widgets.md','hexbot-setup/tui-widgets'],
  ['skills/autonomous-ai-agents/hermes-agent/references/contributor-guide.md','hexbot-setup/plugins'],
]) test(`${directory} output stays in the section workspace`, () => {
  const text = readFileSync(new URL(file,root),'utf8');
  assert.ok(text.includes(`./${directory}`));
  assert.ok(!text.includes(`~/.hexbot/${directory}`));
  assert.ok(!text.includes(`$HOME/.hexbot/${directory}`));
});
