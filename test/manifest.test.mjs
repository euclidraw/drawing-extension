import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPackageManifest } from '../src/manifest.js';
import { validateConfig, validateRange } from '../scripts/validate-config.mjs';

const config = JSON.parse(await readFile(new URL('../extension.json', import.meta.url), 'utf8'));

test('renaming a template regenerates the declared aspect without stale namespace metadata', () => {
  const metadata = { ...config, id: 'sketch.ink-brush' };
  const result = createPackageManifest(validateConfig(metadata));
  assert.deepEqual(result.provides.aspects, ['sketch.ink-brush.stroke']);
  assert.equal(result.version, config.version);
});

test('build validation rejects old config, invalid release versions and unsafe dependency maps', () => {
  const old = { id: config.id, title: config.title, version: config.version, summary: config.summary };
  assert.throws(() => validateConfig(old));
  for (const version of ['01.2.3', '1.2', '1.2.3-beta.1', '1.2.3+build', '9007199254740992.0.0']) {
    assert.throws(() => validateConfig({ ...config, version }));
  }
  for (const id of ['core.override', 'computed.override', 'script.override', 'author.__proto__']) {
    assert.throws(() => validateConfig({ ...config, id }));
  }
  assert.throws(() => validateConfig({ ...config, dependencies: { [config.id]: '*' } }));
  assert.throws(() => validateConfig({ ...config, dependencies: { 'core.select-suite': '*' }, optionalDependencies: { 'core.select-suite': '*' } }));
  assert.throws(() => validateConfig({ ...config, conflicts: [config.id] }));
  assert.throws(() => validateConfig({ ...config, provides: { services: ['a.service', 'a.service'], hsmSlots: [] } }));
  assert.throws(() => validateConfig({ ...config, provides: { services: ['a..service'], hsmSlots: [] } }));
  assert.throws(() => validateConfig({ ...config, provides: { services: [], hsmSlots: ['root.select.'] } }));
  assert.throws(() => validateConfig({ ...config, id: `a.${'b'.repeat(154)}` }));
  assert.throws(() => validateConfig({ ...config, dependencies: JSON.parse('{"__proto__":"*"}') }));
  assert.doesNotThrow(() => validateConfig({ ...config, dependencies: { 'core.select-suite': '^0.1.0' }, optionalDependencies: {} }));
});

test('supported range syntax stays explicit instead of silently weakening invalid ranges', () => {
  for (const range of ['*', '^0.1.0', '^0.0.1', '~1.2.3', '1.x', '1.2.*', '>=0.1.0 <0.2.0', '^0.1.0 || ^1.0.0']) {
    assert.doesNotThrow(() => validateRange(range));
  }
  for (const range of ['', '  ', '*'.repeat(201), '^1.2', '^1.*', '1.0.0 - 2.0.0', '1.0.0-beta', '01.0.0', '1.x.3', '1.0.0 ||', 'latest']) {
    assert.throws(() => validateRange(range));
  }
});
