// Run after npm ci --prefix backend/pi-runtime --ignore-scripts.
import { readFile, writeFile } from 'node:fs/promises';
import { MODELS } from '../pi-runtime/node_modules/@earendil-works/pi-ai/dist/models.generated.js';

const runtime = JSON.parse(await readFile(new URL('../pi-runtime/package.json', import.meta.url), 'utf8'));
const version = runtime.devDependencies['@earendil-works/pi-ai'];
const installed = JSON.parse(await readFile(new URL('../pi-runtime/node_modules/@earendil-works/pi-ai/package.json', import.meta.url), 'utf8'));
if (version !== installed.version || version !== runtime.dependencies['@earendil-works/pi-coding-agent']) {
  throw new Error('Install the pinned runtime before regenerating the catalog');
}
const providers = Object.fromEntries(Object.entries(MODELS).filter(([, models]) => Object.keys(models).length).map(([provider, models]) => [provider, {
  api: Object.values(models)[0].api,
  models: Object.keys(models),
}]));
await writeFile(new URL('./src/pi_catalog.json', import.meta.url), JSON.stringify({ version, providers }));
