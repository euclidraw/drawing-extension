import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { startDevServer } from '../scripts/dev.mjs';

async function events(url, origin) {
  const response = await fetch(url, { headers: { Origin: origin } });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue = [];
  const waiters = [];
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!name) continue;
        const item = { name, data: JSON.parse(data) };
        const index = waiters.findIndex(waiter => waiter.name === item.name);
        if (index >= 0) waiters.splice(index, 1)[0].resolve(item.data);
        else queue.push(item);
      }
    }
  })();
  return {
    next(name) {
      const index = queue.findIndex(item => item.name === name);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0].data);
      return new Promise(resolve => waiters.push({ name, resolve }));
    },
    close: () => reader.cancel(),
  };
}

test('dev server rebuilds on change, serves a matching manifest and bundle, and announces reloads', { timeout: 60_000 }, async () => {
  const origin = 'http://127.0.0.1:5173';
  const source = new URL('../src/index.js', import.meta.url);
  const original = await readFile(source, 'utf8');
  const server = await startDevServer({ port: 0, log: () => {} });
  const stream = await events(`${server.url}/__alid/events`, origin);
  try {
    const first = await stream.next('reload');
    const manifest = await (await fetch(`${server.url}/alid.extension.json`, { headers: { Origin: origin } })).json();
    const bundle = await (await fetch(`${server.url}/${manifest.entry}`, { headers: { Origin: origin } })).text();
    assert.equal(manifest.sha256, createHash('sha256').update(bundle).digest('hex'));
    assert.equal(first.sha256, manifest.sha256);

    await writeFile(source, original.replace('자유 드로잉 도구', '바뀐 자유 드로잉 도구'));
    const second = await stream.next('reload');
    assert.ok(second.revision > first.revision);
    assert.notEqual(second.sha256, first.sha256);
    assert.match(await (await fetch(`${server.url}/dist/plugin.js`)).text(), /바뀐 자유 드로잉 도구/);

    const denied = await fetch(`${server.url}/alid.extension.json`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(denied.status, 403);
    const preflight = await fetch(`${server.url}/alid.extension.json`, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  } finally {
    await writeFile(source, original);
    await stream.close();
    await server.close();
  }
});
