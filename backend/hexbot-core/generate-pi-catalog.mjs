// Run after npm ci --prefix backend/pi-runtime --ignore-scripts.
import { readFile, writeFile } from 'node:fs/promises';
import { MODELS } from '../pi-runtime/node_modules/@earendil-works/pi-ai/dist/models.generated.js';

const runtime = JSON.parse(await readFile(new URL('../pi-runtime/package.json', import.meta.url), 'utf8'));
const version = runtime.devDependencies['@earendil-works/pi-ai'];
const installed = JSON.parse(await readFile(new URL('../pi-runtime/node_modules/@earendil-works/pi-ai/package.json', import.meta.url), 'utf8'));
if (version !== installed.version || version !== runtime.dependencies['@earendil-works/pi-coding-agent']) {
  throw new Error('Install the pinned runtime before regenerating the catalog');
}
// `windows` carries each model's context window, so the daemon can scale its
// compaction budget to models it never writes into models.json.
const providers = Object.fromEntries(Object.entries(MODELS).filter(([, models]) => Object.keys(models).length).map(([provider, models]) => [provider, {
  api: Object.values(models)[0].api,
  models: Object.keys(models),
  windows: Object.fromEntries(Object.entries(models).filter(([, model]) => Number.isInteger(model.contextWindow) && model.contextWindow > 0).map(([id, model]) => [id, model.contextWindow])),
}]));
await writeFile(new URL('./src/pi_catalog.json', import.meta.url), JSON.stringify({ version, providers }));
