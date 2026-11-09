import { build } from 'vite';
import { readConfig, writeInstallManifest } from './install-manifest.mjs';

await readConfig();
await build();
const manifest = await writeInstallManifest();
console.log(`Prepared ${manifest.id} ${manifest.version}: ${manifest.sha256}`);
