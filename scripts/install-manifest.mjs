import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { COMMAND_NAMES, createPackageManifest } from '../src/manifest.js';
import { validateConfig } from './validate-config.mjs';

export const root = new URL('../', import.meta.url);

export async function readConfig() {
  return validateConfig(JSON.parse(await readFile(new URL('extension.json', root), 'utf8')));
}

/**
 * Generates the install manifest (`alid.extension.json`) for the single ESM bundle in `outDir`.
 */
export async function createInstallManifest(outDir = new URL('dist/', root)) {
  const metadata = await readConfig();
  const contract = createPackageManifest(metadata);
  const files = await readdir(outDir);
  if (files.length !== 1 || files[0] !== 'plugin.js') {
    throw new Error('The installer expects one self-contained dist/plugin.js bundle.');
  }
  const bundle = await readFile(new URL('plugin.js', outDir));
  const manifest = {
    apiVersion: 2,
    ...contract,
    title: metadata.title,
    summary: metadata.summary,
    entry: 'dist/plugin.js',
    sha256: createHash('sha256').update(bundle).digest('hex'),
    aspectIds: contract.provides.aspects,
    capabilities: {
      readAspects: [...contract.provides.aspects, 'core.transform', 'core.bounds'],
      writeAspects: [...contract.provides.aspects, 'core.transform', 'core.bounds'],
      services: [
        'canvas.creation',
        'canvas.active-tool-surface',
        'canvas.tool-input',
        'canvas.frames',
        'canvas.gpu-contributions',
        'canvas.selection',
        'canvas.interaction',
        'canvas.surface',
        'extensions.preferences',
        'workspace.tools',
      ],
      commands: COMMAND_NAMES.map(name => `${metadata.id}:${name}`),
    },
  };
  return { manifest, manifestText: `${JSON.stringify(manifest, null, 2)}\n`, bundle };
}

export async function writeInstallManifest() {
  const { manifest, manifestText } = await createInstallManifest();
  await writeFile(new URL('alid.extension.json', root), manifestText);
  return manifest;
}
