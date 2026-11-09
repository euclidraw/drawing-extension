import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import config, { sharedImports } from '../vite.config.js';

async function bundle(source) {
  const directory = await mkdtemp(join(tmpdir(), 'alid-drawing-bundle-'));
  try {
    const entry = join(directory, 'entry.js');
    await writeFile(entry, source);
    const result = await build({
      ...config,
      configFile: false,
      logLevel: 'silent',
      build: { ...config.build, write: false, lib: { ...config.build.lib, entry } },
    });
    return (Array.isArray(result) ? result[0] : result).output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('SDK and React imports stay external and resolve through the host shared module map', async () => {
  const imports = sharedImports.map((id, index) => `import * as shared${index} from '${id}';`).join('\n');
  const output = await bundle(`${imports}\nexport default [${sharedImports.map((_, index) => `shared${index}`).join(',')}];`);
  assert.equal(output.length, 1);
  assert.deepEqual([...output[0].imports].sort(), [...sharedImports].sort());
  assert.ok(output[0].code.length < 4000);
});

test('built dist/plugin.js is self-contained and only imports from host sharedImports', async () => {
  const code = await readFile(new URL('../dist/plugin.js', import.meta.url), 'utf8');
  const staticImports = [...code.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm)].map(m => m[1]);
  for (const spec of staticImports) {
    assert.ok(sharedImports.includes(spec), `Unexpected external import "${spec}" in dist/plugin.js`);
  }
  assert.ok(!code.includes('__require('), 'dist/plugin.js must not emit CommonJS require calls');
});
