import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import plugin, { registerFreehandTools } from '../dist/plugin.js';

const host = resolve(process.env.ALID_PATH ?? '../alid');
const dir = await mkdtemp(join(tmpdir(), 'drawing-extension-host-'));

try {
  const entry = join(dir, 'entry.js');
  await writeFile(
    entry,
    [
      `export { CommandRegistry } from ${JSON.stringify(join(host, 'packages/kernel/src/commands.ts'))};`,
      `export { ServiceRegistry } from ${JSON.stringify(join(host, 'packages/kernel/src/services.ts'))};`,
      `export { ExtensionRuntimeRegistry } from ${JSON.stringify(join(host, 'packages/kernel/src/extension-controller.ts'))};`,
      `export { CanvasWorld } from ${JSON.stringify(join(host, 'packages/kernel/src/kernel-data.ts'))};`,
      `export { SceneVectorCompiler } from ${JSON.stringify(join(host, 'packages/kernel/src/scene-compiler.ts'))};`,
      `export { installPorcelainExtension } from ${JSON.stringify(join(host, 'packages/kernel/src/porcelain-and-trust.ts'))};`,
      `export { createWorkspaceChanges } from ${JSON.stringify(join(host, 'packages/kernel/src/workspace-changes.ts'))};`,
      `export { WorkspaceToolRegistry } from ${JSON.stringify(join(host, 'packages/kernel/src/workspace-tools.ts'))};`,
      `export { ToolStateMachine } from ${JSON.stringify(join(host, 'packages/kernel/src/hsm.ts'))};`,
      `export { validateRepositoryManifest, validatePluginSpec } from ${JSON.stringify(join(host, 'apps/playground/src/repository-plugins.ts'))};`,
    ].join('\n'),
  );

  await build({
    configFile: false,
    logLevel: 'error',
    plugins: [
      {
        name: 'stub-quickjs',
        resolveId(id) {
          if (id === 'quickjs-emscripten') return '\0quickjs-emscripten';
          return null;
        },
        load(id) {
          if (id === '\0quickjs-emscripten') return 'export const getQuickJS = async () => ({}); export default {};';
          return null;
        },
      },
    ],
    build: {
      target: 'esnext',
      outDir: join(dir, 'out'),
      lib: { entry, formats: ['es'], fileName: () => 'host.mjs' },
    },
  });

  const {
    CanvasWorld,
    installPorcelainExtension,
    SceneVectorCompiler,
    CommandRegistry,
    ServiceRegistry,
    ExtensionRuntimeRegistry,
    createWorkspaceChanges,
    WorkspaceToolRegistry,
    ToolStateMachine,
    validateRepositoryManifest,
    validatePluginSpec,
  } = await import(pathToFileURL(join(dir, 'out/host.mjs')));

  // 1. Validate alid.extension.json and dist/plugin.js against host repository installer validators
  const rawManifest = JSON.parse(await readFile(new URL('../alid.extension.json', import.meta.url), 'utf8'));
  const validatedManifest = validateRepositoryManifest(rawManifest);
  validatePluginSpec(plugin, validatedManifest);

  // 2. Load real Rust WasmCanvasCore and verify world + compiler + Undo/Redo + analytical selection
  const wasm = await import(pathToFileURL(join(host, 'crates/ecanvas-core/pkg/ecanvas_core.js')));
  await wasm.default({
    module_or_path: await readFile(join(host, 'crates/ecanvas-core/pkg/ecanvas_core_bg.wasm')),
  });
  const core = new wasm.WasmCanvasCore();
  let commits = 0;
  const world = new CanvasWorld({
    commitCanonicalBatch(bytes, origin) {
      commits++;
      core.commit_canonical_batch(bytes, origin);
    },
    updateSpatialBounds() {},
  });
  const compiler = new SceneVectorCompiler();
  world.registerCanonical({
    id: 'core.transform',
    defaults: { x: 0, y: 0, rotation: 0 },
  });
  world.registerCanonical({
    id: 'core.bounds',
    defaults: { width: 180 },
    optionalFields: ['height'],
  });
  world.registerComputed({
    id: 'computed.layoutBounds',
    symbol: 'test:bounds',
    dependsOnCanonical: ['core.transform', 'core.bounds'],
    compute(id, view) {
      const t = view.getCanonical(id, 'core.transform');
      const b = view.getCanonical(id, 'core.bounds');
      return t && b ? { ...t, ...b } : undefined;
    },
  });

  const specs = [];
  for (const spec of plugin.aspects) {
    installPorcelainExtension(
      spec,
      world,
      {
        registerExtension(s) {
          specs.push(s);
          return compiler.registerExtension(s);
        },
      },
      'trusted-tier1',
    );
  }

  let selected = [];
  let registeredContribution = null;
  const stateMachine = new ToolStateMachine('root.select.idle', [
    {
      id: 'root',
      initial: 'root.select',
      children: [
        {
          id: 'root.select',
          initial: 'root.select.idle',
          children: [{ id: 'root.select.idle' }],
        },
      ],
    },
  ]);

  const runtime = plugin.activate({
    world,
    commands: {
      register() {
        return () => {};
      },
    },
    services: {
      get(name) {
        if (name === 'canvas.creation') {
          return {
            create(request) {
              if (!request || typeof request.caller !== 'string' || !request.caller.includes(':') || request.caller.trim() !== request.caller) {
                throw new Error('Entity creation requires a named caller symbol.');
              }
              if (!Number.isFinite(request.width) || request.width <= 0 || (request.height !== undefined && (!Number.isFinite(request.height) || request.height <= 0))) {
                throw new Error('Entity dimensions must be finite positive numbers.');
              }
              for (const [aspect] of Object.entries(request.aspects ?? {})) {
                if (aspect === 'core.transform' || aspect === 'core.bounds') {
                  throw new Error(`Entity placement aspect is owned by the canvas: ${aspect}`);
                }
              }
              const id = `ent_stroke_${crypto.randomUUID()}`;
              world.validateCanonicalSnapshot({ [id]: request.aspects });
              core.begin_undo_group();
              try {
                world.applyCanonicalTransaction(request.caller, [
                  { id, aspect: 'core.transform', patch: { x: request.x ?? 80, y: request.y ?? 80, rotation: 0 } },
                  { id, aspect: 'core.bounds', patch: { width: request.width, ...(request.height !== undefined ? { height: request.height } : {}) } },
                  ...Object.entries(request.aspects).map(([aspect, patch]) => ({ id, aspect, patch })),
                ]);
                core.end_undo_group();
              } catch (error) {
                core.abort_undo_group();
                world.replaceCanonicalSnapshot(core.get_canonical_json());
                throw error;
              }
              selected = [id];
              return id;
            },
          };
        }
        if (name === 'canvas.selection') {
          return {
            stateMachine,
            getSelection: () => selected,
            select(id) {
              selected = [id];
            },
            clear() {
              selected = [];
            },
            registerContribution(contribution) {
              registeredContribution = contribution;
              return () => {
                registeredContribution = null;
              };
            },
          };
        }
        if (name === 'canvas.active-tool-surface') {
          return {
            get: () => ({
              selection: {
                stateMachine,
                getSelection: () => selected,
                select(id) {
                  selected = [id];
                },
              },
              host: {
                history: {
                  begin() {
                    core.begin_undo_group();
                  },
                  commit() {
                    core.end_undo_group();
                  },
                  abort() {
                    core.abort_undo_group();
                    world.replaceCanonicalSnapshot(core.get_canonical_json());
                  },
                },
              },
            }),
          };
        }
        return undefined;
      },
    },
  });

  assert.ok(registeredContribution, 'Analytical EntitySelectionContribution is registered');
  const createdId = runtime.api.insertStroke({ preset: 'wave', brush: 'pen', stroke: '#3182f6' });
  assert.ok(createdId, 'insert-stroke creates a stroke entity');
  assert.equal(commits, 1);

  for (const id of world.listEntityIds()) {
    for (const spec of specs) {
      const props = world.getCanonical(id, spec.id);
      if (props) {
        const geom = world.getComputed(id, `computed.${spec.id}`);
        assert.ok(geom, `${id} ${spec.id}`);
        const { svg } = spec.renderSvg(props, geom, id);
        assert.ok(!svg.includes('NaN'), 'rendered SVG contains no NaN');
        assert.ok(!svg.includes('foreignObject'), 'rendered SVG contains no foreignObject');
      }
    }
  }

  // Verify analytical selection contribution against real world view
  const firstPt = world.getComputed(createdId, `computed.${plugin.aspects[0].id}`).sampledPoints[0];
  assert.ok(registeredContribution.hitTest(createdId, world, firstPt.x, firstPt.y, 1) <= 8);
  assert.equal(registeredContribution.hitTest(createdId, world, -9999, -9999, 1), Infinity);

  const before = commits;
  const snapshot = core.dump_canonical_jsonl();
  const svg = compiler.compileToPureSvg(world);
  assert.ok(svg.includes('data-entity-id'));
  assert.ok(!svg.includes('foreignObject'));
  assert.equal(core.dump_canonical_jsonl(), snapshot);
  assert.equal(commits, before);

  // Verify real Rust Undo / Redo
  assert.equal(core.undo(), true);
  world.replaceCanonicalSnapshot(core.get_canonical_json());
  assert.equal(world.listEntityIds().length, 0);
  assert.equal(core.redo(), true);
  world.replaceCanonicalSnapshot(core.get_canonical_json());
  assert.equal(core.dump_canonical_jsonl(), snapshot);

  // Verify Scratch Overlay isolation
  const preview = world.createScratchOverlay('test:preview');
  preview.set(createdId, 'core.transform', { x: 999999, y: 0, rotation: 0 });
  assert.equal(compiler.compileToPureSvg(world), svg);
  preview.dispose();

  // Verify Copilot WorkspaceToolRegistry + prepareChange approval flow
  const lifetime = new AbortController();
  const changes = createWorkspaceChanges(
    world,
    (caller, ops) => {
      core.begin_undo_group();
      try {
        world.applyCanonicalTransaction(caller, ops);
        core.end_undo_group();
      } catch (error) {
        core.abort_undo_group();
        world.replaceCanonicalSnapshot(core.get_canonical_json());
        throw error;
      }
    },
    () => ({ documentId: 'test-doc', viewId: 'main', signal: lifetime.signal }),
  );
  const toolRegistry = new WorkspaceToolRegistry(changes);
  const toolAccess = toolRegistry.forExtension(
    plugin.id,
    [plugin.aspects[0].id],
    () => {},
    () => true,
  );
  const offTools = registerFreehandTools({
    world,
    services: {
      get: name => (name === 'workspace.tools' ? toolAccess : undefined),
    },
  });

  const proposal = await toolAccess.invoke(
    'drawing.freehand:plan-changes',
    {
      actions: JSON.stringify([
        {
          action: 'create',
          id: 'circle-1',
          x: 240,
          y: 180,
          patch: { preset: 'circle', brush: 'marker', stroke: '#10b981', fill: '#10b981', fillOpacity: 0.2 },
        },
      ]),
    },
    lifetime.signal,
  );
  assert.ok(proposal.changeProposalId);
  const changeSet = toolAccess.getChangeProposal(proposal.changeProposalId);
  changes.apply(changeSet);
  assert.equal(world.listEntityIds().length, 2);

  offTools();
  runtime.dispose();

  // 3. Verify full ExtensionRuntimeRegistry lifecycle activation & reload
  const world2 = new CanvasWorld({
    commitCanonicalBatch() {},
    updateSpatialBounds() {},
  });
  const compiler2 = new SceneVectorCompiler();
  world2.registerCanonical({ id: 'core.transform', defaults: { x: 0, y: 0, rotation: 0 } });
  world2.registerCanonical({ id: 'core.bounds', defaults: { width: 180 }, optionalFields: ['height'] });
  const services2 = new ServiceRegistry();
  const commands2 = new CommandRegistry(world2);
  services2.provide('canvas.creation', {
    create: () => 'created-via-registry',
  });
  const extRegistry = new ExtensionRuntimeRegistry({
    world: world2,
    compiler: compiler2,
    services: services2,
    commands: commands2,
  });
  const offPkg = extRegistry.registerPackages([{ spec: plugin, manifest: validatedManifest }]);
  const snap = extRegistry.getSnapshot();
  const extState = snap.find(item => item.id === validatedManifest.id);
  assert.equal(extState?.state, 'active');
  offPkg();
  extRegistry.dispose();

  console.log('Host Wasm + SceneVectorCompiler + WorkspaceToolRegistry + ExtensionRuntimeRegistry verification passed!');
} finally {
  await rm(dir, { recursive: true, force: true });
}
