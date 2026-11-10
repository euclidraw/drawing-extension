import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import plugin, {
  FREEHAND_TOOL_STATE,
  STROKE_ASPECT_ID,
  STROKE_DEFAULTS,
  createStrokeGpuContribution,
  createStrokeSelectionContribution,
  deriveStrokeGeometry,
  getStrokeOutlinePoints,
  getStrokePoints,
  getSvgPathFromStrokePoints,
  normalizeStrokeGeometry,
  planFreehandChanges,
  simplifyStrokePoints,
} from '../dist/plugin.js';

const manifest = JSON.parse(await readFile(new URL('../alid.extension.json', import.meta.url), 'utf8'));
const aspect = plugin.aspects[0];

test('committed install manifest matches the built bundle and SHA-256 hash', async () => {
  assert.equal(manifest.apiVersion, 2);
  assert.equal(manifest.id, plugin.id);
  for (const key of ['version', 'engine', 'dependencies', 'optionalDependencies', 'conflicts', 'provides']) {
    assert.deepEqual(manifest[key], plugin[key], `Manifest ${key} must match runtime package`);
  }
  assert.deepEqual(manifest.provides.aspects, manifest.aspectIds);
  assert.deepEqual(manifest.aspectIds, plugin.aspects.map(item => item.id));
  assert.equal(manifest.entry, 'dist/plugin.js');
  const bytes = await readFile(new URL('../dist/plugin.js', import.meta.url));
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('activation registers commands without mutating the document, and disposal cleans up', () => {
  const registeredCommands = new Map();
  let createdRequest = null;
  let removedCount = 0;

  const { api, dispose } = plugin.activate({
    world: {
      getCanonical: () => undefined,
    },
    services: {
      get: name =>
        name === 'canvas.creation'
          ? {
              create(request) {
                createdRequest = request;
                return 'stroke-1';
              },
            }
          : undefined,
    },
    commands: {
      register(spec) {
        registeredCommands.set(spec.id, spec);
        return () => {
          removedCount++;
        };
      },
    },
  });

  assert.equal(createdRequest, null, 'activation must not create or mutate entities');
  assert.equal(registeredCommands.size, manifest.capabilities.commands.length);

  // Clicking the toolbar draw-tool command enters FREEHAND_TOOL_STATE and NEVER creates a pre-drawn stroke
  const drawToolCmd = registeredCommands.get('drawing.freehand:draw-tool');
  assert.ok(drawToolCmd);
  assert.equal(drawToolCmd.run(), FREEHAND_TOOL_STATE);
  assert.equal(createdRequest, null, 'draw-tool command must only toggle drawing mode, never spawn a preset entity');

  // Explicit insert-stroke command creates a stroke entity when requested
  const insertStrokeCmd = registeredCommands.get('drawing.freehand:insert-stroke');
  assert.ok(insertStrokeCmd);
  assert.equal(insertStrokeCmd.run(), 'stroke-1');
  assert.ok(createdRequest);
  assert.equal(Object.hasOwn(createdRequest.aspects, 'core.transform'), false);
  assert.equal(Object.hasOwn(createdRequest.aspects, 'core.bounds'), false);
  assert.ok(createdRequest.aspects[STROKE_ASPECT_ID]);

  dispose();
  dispose();
  assert.equal(removedCount, manifest.capabilities.commands.length);
  assert.throws(() => api.insertStroke(), /비활성화/);
});

test('toolbar and inspector declarative controls bind to valid commands and canonical default fields', () => {
  const shelfAction = plugin.ui.controls[0];
  assert.equal(shelfAction.placement, 'tool-shelf');
  assert.equal(shelfAction.requiresSelection, false);
  assert.equal(shelfAction.activeToolState, FREEHAND_TOOL_STATE);
  assert.equal(shelfAction.commandSymbol, 'drawing.freehand:draw-tool');

  for (const control of aspect.ui.controls) {
    if (control.kind !== 'action') {
      assert.ok(
        Object.hasOwn(aspect.defaults, control.field),
        `Control ${control.id} references unknown field ${control.field}`,
      );
    }
  }
});

test('derive is pure, caches frozen local geometry across transform moves, and handles invalid bounds', () => {
  const frozenProps = Object.freeze({ ...STROKE_DEFAULTS });
  const reads = [];
  const derived1 = aspect.derive(frozenProps, 'stroke-1', {
    getCanonical(id, name) {
      reads.push([id, name]);
      if (name === 'core.transform') return { x: 40, y: 60, rotation: 0 };
      if (name === 'core.bounds') return { width: 180, height: 96 };
      return undefined;
    },
  });

  assert.equal(derived1.x, 40);
  assert.equal(derived1.y, 60);
  assert.equal(derived1.width, 180);
  assert.equal(derived1.height, 96);
  assert.equal(derived1.renderMode, 'freehand-outline');
  assert.ok(derived1.outlinePathD.startsWith('M '));
  assert.ok(derived1.inkBounds.width > 160);
  assert.equal(Object.hasOwn(derived1, 'zOrder'), false);

  // Moving transform (x, y) reuses the cached local outlinePathD string reference
  const derived2 = aspect.derive(frozenProps, 'stroke-1', {
    getCanonical(_id, name) {
      if (name === 'core.transform') return { x: 240, y: 160, rotation: 0 };
      if (name === 'core.bounds') return { width: 180, height: 96 };
      return undefined;
    },
  });
  assert.equal(derived1.outlinePathD, derived2.outlinePathD);
  assert.equal(derived2.inkBounds.x, round2(derived1.inkBounds.x + 200));
  assert.equal(derived2.inkBounds.y, round2(derived1.inkBounds.y + 100));

  // Invalid / NaN bounds remain finite
  const fallback = aspect.derive(frozenProps, 'stroke-nan', {
    getCanonical: () => ({ x: Infinity, y: NaN, rotation: NaN, width: -50, height: NaN }),
  });
  assert.equal(fallback.x, 0);
  assert.equal(fallback.y, 0);
  assert.equal(fallback.width, STROKE_DEFAULTS.baseWidth);
  assert.equal(fallback.height, STROKE_DEFAULTS.baseHeight);
  assert.ok(!fallback.pathD.includes('NaN'));
});

function round2(v) {
  return Math.round(v * 100) / 100;
}

test('tldraw freehand pipeline: streamline, variable-width outline, quadratic Bezier path, dot mode, and RDP decimation', () => {
  // 1. Variable-width freehand stroke
  const raw = [
    { x: 0, y: 0, z: 0.25 },
    { x: 20, y: 5, z: 0.5 },
    { x: 45, y: 18, z: 0.85 },
    { x: 75, y: 20, z: 0.6 },
    { x: 100, y: 8, z: 0.3 },
  ];
  const strokePts = getStrokePoints(raw, { size: 8, streamline: 0.5 });
  assert.ok(strokePts.length >= 4);
  assert.ok(strokePts[strokePts.length - 1].runningLength > 80);

  const outline = getStrokeOutlinePoints(strokePts, {
    size: 8,
    thinning: 0.6,
    smoothing: 0.5,
    simulatePressure: false,
  });
  assert.ok(outline.length > strokePts.length * 2);

  const d = getSvgPathFromStrokePoints(outline, true);
  assert.match(d, /^M .* Q .* T .* Z$/);
  assert.ok(!d.includes('NaN'));

  // 2. Dot detection for tiny tap strokes
  const dotDerived = deriveStrokeGeometry(
    {
      ...STROKE_DEFAULTS,
      points: [{ x: 10, y: 10, z: 0.6 }],
      baseWidth: 20,
      baseHeight: 20,
    },
    'dot-1',
    {
      getCanonical(_id, name) {
        return name === 'core.transform' ? { x: 0, y: 0, rotation: 0 } : { width: 20, height: 20 };
      },
    },
  );
  assert.equal(dotDerived.isDot, true);
  assert.equal(dotDerived.renderMode, 'dot');
  assert.match(dotDerived.pathD, /a .* 0 1 0/);

  // 3. Collinear point decimation via iterative RDP preserves straight-segment anchors
  const denseLine = [];
  for (let i = 0; i <= 50; i++) {
    denseLine.push({ x: i * 2, y: i * 1, z: 0.5, seg: i === 25 ? 1 : 0 });
  }
  const simplified = simplifyStrokePoints(denseLine, 0.5);
  assert.ok(simplified.length <= 4, `Expected collinear points to simplify, got ${simplified.length}`);
  assert.ok(simplified.some(p => p.x === 50 && p.y === 25), 'Segment transition anchor must be preserved');

  // 4. Rebounding into local [0..baseWidth, 0..baseHeight]
  const normalized = normalizeStrokeGeometry([
    { x: 150, y: 220, z: 0.4 },
    { x: 210, y: 280, z: 0.7, seg: 1 },
  ]);
  assert.equal(normalized.x, 150);
  assert.equal(normalized.y, 220);
  assert.equal(normalized.baseWidth, 60);
  assert.equal(normalized.baseHeight, 60);
  assert.deepEqual(normalized.points[0], { x: 0, y: 0, z: 0.4 });
  assert.deepEqual(normalized.points[1], { x: 60, y: 60, z: 0.7 });
  assert.deepEqual(normalized.segments, [{ type: 'straight', startIndex: 0, endIndex: 1 }]);
});

test('interactive FreeDrawTool: 0-GC pointermove, Shift straight-line snap, IME guard, Escape abort, and single-Undo commit', () => {
  const surfaceListeners = new Map();
  const winListeners = new Map();
  const mountedHsmNodes = new Map();
  let frameCallback = null;
  let currentState = 'root.select.core.select-suite:idle';
  mountedHsmNodes.set('root.select.core.select-suite:idle', { id: 'root.select.core.select-suite:idle' });
  const createdEntities = [];

  const mockDoc = {
    defaultView: {
      addEventListener(type, fn) {
        winListeners.set(type, fn);
      },
      removeEventListener(type) {
        winListeners.delete(type);
      },
    },
    createElementNS(_ns, tag) {
      const attrs = new Map();
      return {
        tagName: tag,
        dataset: {},
        style: {},
        children: [],
        setAttribute(k, v) {
          attrs.set(k, String(v));
        },
        getAttribute(k) {
          return attrs.get(k) ?? '';
        },
        removeAttribute(k) {
          attrs.delete(k);
        },
        append(...nodes) {
          this.children.push(...nodes);
        },
        remove() {},
      };
    },
  };

  const mockSurface = {
    ownerDocument: mockDoc,
    dataset: {},
    style: {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
    addEventListener(type, fn) {
      surfaceListeners.set(type, fn);
    },
    removeEventListener(type) {
      surfaceListeners.delete(type);
    },
    setPointerCapture() {},
    hasPointerCapture: () => true,
    releasePointerCapture() {},
  };

  const mockHud = {
    ownerDocument: mockDoc,
    children: [],
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
    append(node) {
      this.children.push(node);
    },
  };

  const stateMachine = {
    get stateId() {
      return currentState;
    },
    mountChildState(_parent, node) {
      mountedHsmNodes.set(node.id, node);
      return () => mountedHsmNodes.delete(node.id);
    },
    transition(target) {
      if (!mountedHsmNodes.has(target)) return false;
      const prev = mountedHsmNodes.get(currentState);
      prev?.onExit?.();
      currentState = target;
      const next = mountedHsmNodes.get(target);
      next?.onEnter?.();
      return true;
    },
    dispatch(event) {
      return mountedHsmNodes.get(currentState)?.onEvent?.(event) ?? false;
    },
  };

  const surfaceListenersSet = new Set();
  const { api, dispose } = plugin.activate({
    world: { getCanonical: () => undefined },
    commands: { register: () => () => {} },
    services: {
      get(name) {
        if (name === 'canvas.creation') {
          return {
            create(req) {
              createdEntities.push(req);
              // Simulate Alid's runtime.ts createEntity() which calls setMode('select')
              stateMachine.transition('root.select.core.select-suite:idle');
              return `stroke-${createdEntities.length}`;
            },
          };
        }
        if (name === 'canvas.frames') {
          return {
            subscribe(fn) {
              frameCallback = fn;
              return () => {
                frameCallback = null;
              };
            },
          };
        }
        if (name === 'canvas.active-tool-surface') {
          return {
            get: () => ({
              surface: {
                element: mockSurface,
                hud: mockHud,
              },
              host: {
                screenToWorld(clientX, clientY, out) {
                  out.x = clientX - 10;
                  out.y = clientY - 20;
                },
                worldToScreen(wx, wy, out) {
                  out.x = wx + 10;
                  out.y = wy + 20;
                },
                getZoom: () => 1,
                requestRender() {},
              },
              selection: {
                stateMachine,
                getSelection: () => [],
                clear() {},
                select() {},
              },
            }),
            // Alid's subscribe() does NOT invoke the listener on registration
            subscribe(listener) {
              surfaceListenersSet.add(listener);
              return () => surfaceListenersSet.delete(listener);
            },
          };
        }
        return undefined;
      },
    },
  });

  // 1. Toggle into Freehand Draw Tool (must mount on activation even when subscribe is present)
  assert.ok(api.getActiveTool(), 'FreeDrawTool must be mounted on activation');
  assert.equal(api.toggleDrawTool(), FREEHAND_TOOL_STATE);
  assert.equal(currentState, FREEHAND_TOOL_STATE);
  assert.equal(mockSurface.dataset.activeTool, 'drawing.freehand');
  assert.equal(createdEntities.length, 0, 'Toggling into draw tool must never create an entity');

  // 2. Start drawing with pen pressure & coalesced events + Shift straight-line snap
  surfaceListeners.get('pointerdown')({
    button: 0,
    pointerId: 1,
    pointerType: 'pen',
    pressure: 0.4,
    clientX: 110,
    clientY: 120,
  });

  surfaceListeners.get('pointermove')({
    pointerId: 1,
    pointerType: 'pen',
    pressure: 0.75,
    clientX: 160,
    clientY: 150,
    getCoalescedEvents: () => [
      { pointerType: 'pen', pressure: 0.6, clientX: 135, clientY: 135 },
      { pointerType: 'pen', pressure: 0.75, clientX: 160, clientY: 150 },
    ],
  });

  // Hold Shift + Ctrl for 15-degree snapped straight segment
  surfaceListeners.get('pointermove')({
    pointerId: 1,
    pointerType: 'pen',
    pressure: 0.8,
    shiftKey: true,
    ctrlKey: true,
    clientX: 260,
    clientY: 152,
  });

  assert.equal(createdEntities.length, 0, 'pointermove must never write to canonical world before pointerup');
  frameCallback?.();

  // 3. Korean IME composition guard: Escape during IME composition must NOT cancel drawing
  winListeners.get('compositionstart')();
  winListeners.get('keydown')({ key: 'Escape', isComposing: true, keyCode: 229 });
  assert.equal(api.getActiveTool().drawing, true, 'IME Escape must not abort active stroke');
  winListeners.get('compositionend')();

  // 4. Finish stroke on pointerup -> commits exactly 1 batch via canvas.creation.create
  surfaceListeners.get('pointerup')({ pointerId: 1 });
  assert.equal(createdEntities.length, 1);
  const committed = createdEntities[0];
  assert.equal(committed.x, 100);
  assert.equal(committed.y, 100);
  const strokeAspect = committed.aspects[STROKE_ASPECT_ID];
  assert.equal(strokeAspect.isPen, true);
  assert.equal(strokeAspect.segments.length, 1);
  assert.equal(strokeAspect.segments[0].type, 'straight');

  // 5. Start another stroke and cancel with Escape -> zero canonical commits
  this_wait: {
    api.getActiveTool().compositionEndedAt = -Infinity;
    surfaceListeners.get('pointerdown')({
      button: 0,
      pointerId: 2,
      clientX: 50,
      clientY: 50,
    });
    surfaceListeners.get('pointermove')({
      pointerId: 2,
      clientX: 90,
      clientY: 90,
    });
    winListeners.get('keydown')({ key: 'Escape', isComposing: false, keyCode: 27 });
    assert.equal(api.getActiveTool().drawing, false);
    assert.equal(currentState, FREEHAND_TOOL_STATE, 'Escape during active stroke aborts draft but stays in draw tool');
    assert.equal(createdEntities.length, 1, 'Canceled stroke must not commit to world');

    // Second Escape (or toggleDrawTool) exits draw tool back to SelectSuite idle
    assert.equal(api.toggleDrawTool(), 'root.select.core.select-suite:idle');
    assert.equal(currentState, 'root.select.core.select-suite:idle');
    break this_wait;
  }

  dispose();
});

test('analytical selection contribution and GPU polyline contribution', () => {
  const props = {
    ...STROKE_DEFAULTS,
    brush: 'fine',
    thinning: 0,
    stroke: '#3182f6',
    strokeWidth: 8,
    points: [
      { x: 0, y: 0, z: 0.5 },
      { x: 100, y: 0, z: 0.5 },
    ],
    baseWidth: 100,
    baseHeight: 10,
  };
  const view = {
    isAlive: () => true,
    getCanonical(id, aspectId) {
      if (id !== 's1') return undefined;
      if (aspectId === STROKE_ASPECT_ID) return props;
      if (aspectId === 'core.transform') return { x: 50, y: 100, rotation: 0 };
      if (aspectId === 'core.bounds') return { width: 100, height: 10 };
      return undefined;
    },
    getComputed(id, computedId) {
      if (id === 's1' && computedId === `computed.${STROKE_ASPECT_ID}`) {
        return deriveStrokeGeometry(props, 's1', this);
      }
      return undefined;
    },
  };

  const selection = createStrokeSelectionContribution();
  const boundsOut = { x: 0, y: 0, width: 0, height: 0, rotation: 0 };
  assert.equal(selection.getBounds('s1', view, boundsOut), true);
  assert.equal(boundsOut.x, 50);
  assert.equal(boundsOut.y, 100);

  // Hit on the horizontal stroke line (y = 100, x = 80)
  assert.equal(selection.hitTest('s1', view, 80, 100, 1), 0);
  // Miss far away
  assert.equal(selection.hitTest('s1', view, 80, 300, 1), Infinity);
  // Marquee intersection
  assert.equal(selection.intersectsRect('s1', view, 70, 95, 90, 105), true);
  assert.equal(selection.intersectsRect('s1', view, 70, 200, 90, 250), false);

  // tldraw parity: selection/hover gizmo is the bounding box, not a stroke-shaped line
  assert.equal(selection.getOutlinePath, undefined, 'stroke must not draw a line-shaped outline');
  assert.equal(boundsOut.width, 100);
  assert.equal(boundsOut.height, 10);
  assert.equal(selection.canTransform('s1', view), true);
  assert.equal(selection.canResize('s1', view), true);
  assert.equal(selection.canRotate('s1', view), true);
  assert.equal(selection.canTransform('missing', view), false);

  // GPU contribution returns polyline for uniform solid stroke
  const gpu = createStrokeGpuContribution();
  const poly = gpu.getPolyline('s1', view);
  assert.ok(poly);
  assert.equal(poly.width, 8);
  assert.equal(poly.color.length, 4);
});

test('DOM and SVG renderers escape attributes, reject unsafe colors, and never emit foreignObject', () => {
  const maliciousProps = {
    ...STROKE_DEFAULTS,
    brush: '"><script>alert(1)</script>',
    stroke: 'url(https://evil.invalid/xss)',
    fill: 'javascript:alert(1)',
  };
  const geometry = { x: 15, y: 25, width: 180, height: 96, rotation: Math.PI / 4 };
  const { svg } = aspect.renderSvg(maliciousProps, geometry, '"><img src=x onerror=alert(1)>');
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('https://evil.invalid'));
  assert.ok(!svg.includes('javascript:'));
  assert.ok(!svg.includes('foreignObject'));
  assert.ok(svg.includes('&quot;&gt;&lt;img'));

  const container = { innerHTML: '' };
  const cleanup = aspect.renderDom(container, maliciousProps, geometry, 's1');
  assert.ok(container.innerHTML.includes('viewBox="0 0 180 96"'));
  assert.ok(!container.innerHTML.includes('<script>'));
  cleanup();
  assert.equal(container.innerHTML, '');
});

test('Copilot planFreehandChanges validates actions and builds atomic CanonicalPatchOp batches', () => {
  const mockWorld = {
    isAlive: id => id === 'existing-1',
    getCanonical: (id, aspectId) => {
      if (id === 'existing-1' && aspectId === STROKE_ASPECT_ID) return STROKE_DEFAULTS;
      if (id === 'existing-1' && aspectId === 'core.transform') return { x: 10, y: 20, rotation: 0 };
      if (id === 'existing-1' && aspectId === 'core.bounds') return { width: 180, height: 96 };
      return undefined;
    },
    exportCanonicalSnapshot: () => ({ 'existing-1': { [STROKE_ASPECT_ID]: STROKE_DEFAULTS } }),
  };

  const ops = planFreehandChanges(mockWorld, [
    {
      action: 'create',
      id: 'new-wave',
      x: 100,
      y: 140,
      patch: { preset: 'circle', brush: 'marker', stroke: '#ef4444', strokeWidth: 10 },
    },
    {
      action: 'update',
      id: 'existing-1',
      patch: { brush: 'highlighter', stroke: '#f59e0b', dash: 'dashed' },
    },
    {
      action: 'move',
      id: 'existing-1',
      x: 300,
      y: 320,
      width: 240,
      height: 120,
    },
    {
      action: 'delete',
      id: 'existing-1',
    },
  ]);

  assert.equal(ops.length, 7);
  assert.equal(ops[2].aspect, STROKE_ASPECT_ID);
  assert.equal(ops[2].patch.isClosed, true);
  assert.equal(ops[2].patch.brush, 'marker');
  assert.equal(ops[3].patch.dash, 'dashed');
  assert.equal(ops[6].patch, null);
});
