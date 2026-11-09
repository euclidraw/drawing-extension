import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createInstallManifest, readConfig, root } from './install-manifest.mjs';

const DEFAULT_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const HEARTBEAT_MS = 15_000;

export async function startDevServer({ port = 5174, host = '127.0.0.1', origins = DEFAULT_ORIGINS, log = console.log } = {}) {
  const allowed = new Set(origins);
  const clients = new Set();
  let current = null;
  let building = false;
  let lastError = null;

  const send = (response, event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => {
    for (const client of clients) send(client, event, data);
  };
  const status = () => ({
    building,
    error: lastError,
    ...(current
      ? {
          id: current.manifest.id,
          version: current.manifest.version,
          sha256: current.manifest.sha256,
          revision: current.revision,
        }
      : {}),
  });

  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin && !allowed.has(origin)) {
      response.writeHead(403).end('Origin not allowed. Add it with --origin.');
      return;
    }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response
        .writeHead(204, {
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Accept',
          'Access-Control-Allow-Private-Network': 'true',
        })
        .end();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/__alid/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      response.write('retry: 1000\n\n');
      send(response, 'hello', status());
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (!current) {
      response
        .writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(lastError ? `Build failed: ${lastError}` : 'First build in progress.');
      return;
    }
    if (path === '/alid.extension.json') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(current.manifestText);
      return;
    }
    if (path === `/${current.manifest.entry}`) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(current.bundle);
      return;
    }
    response.writeHead(404).end();
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, HEARTBEAT_MS);

  await readConfig();
  let revision = 0;
  const outDir = new URL(`.alid-dev/${port || 'auto'}-${process.pid}/`, root);
  const watcher = await build({
    logLevel: 'warn',
    root: fileURLToPath(root),
    configFile: fileURLToPath(new URL('vite.config.js', root)),
    build: { outDir: fileURLToPath(outDir), emptyOutDir: true, watch: {} },
  });

  watcher.on('event', async event => {
    if (event.code === 'START') {
      building = true;
      broadcast('building', {});
    } else if (event.code === 'ERROR') {
      building = false;
      lastError = String(event.error?.message ?? event.error).slice(0, 4000);
      event.result?.close?.();
      log(`✗ build failed: ${lastError}`);
      broadcast('build-error', { message: lastError });
    } else if (event.code === 'BUNDLE_END') {
      event.result?.close?.();
    } else if (event.code === 'END') {
      building = false;
      try {
        const { manifest, manifestText, bundle } = await createInstallManifest(outDir);
        current = { manifest, manifestText, bundle, revision: ++revision };
        lastError = null;
        log(`✓ ${manifest.id} ${manifest.version} #${revision} ${manifest.sha256.slice(0, 12)}`);
        broadcast('reload', status());
      } catch (error) {
        lastError = String(error?.message ?? error);
        log(`✗ ${lastError}`);
        broadcast('build-error', { message: lastError });
      }
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const url = `http://${host}:${typeof address === 'object' && address ? address.port : port}`;
  return {
    url,
    close: async () => {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      await watcher.close();
      await new Promise(resolveClose => server.close(resolveClose));
      await rm(outDir, { recursive: true, force: true });
    },
  };
}

function parseArgs(argv) {
  const options = { origins: [...DEFAULT_ORIGINS] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--port') {
      options.port = Number(value);
      index++;
    } else if (flag === '--origin' && value) {
      options.origins.push(new URL(value).origin);
      index++;
    }
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = await startDevServer(parseArgs(process.argv.slice(2)));
  console.log(`\nalid dev extension server: ${server.url}`);
  console.log('Connect this URL in alid → 확장 관리 → 개발 중인 확장 연결.\n');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }
}
