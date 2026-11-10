import metadata from '../extension.json' with { type: 'json' };
import { FreeDrawTool, SELECT_IDLE_STATE, getMachineStateId, transitionMachineToIdle } from './draw-tool.js';
import {
  BRUSH_TYPES,
  DASH_TYPES,
  DEFAULT_BASE_HEIGHT,
  DEFAULT_BASE_WIDTH,
  STROKE_DEFAULTS,
  clamp,
  createPresetStroke,
  deriveStrokeGeometry,
  finiteOr,
  getStrokeOutlinePoints,
  getStrokePoints,
  getSvgPathFromStrokePoints,
  normalizeBrush,
  normalizeDash,
  normalizeStrokeGeometry,
  resolveStrokeStyle,
  round2,
  round3,
  sanitizeColor,
  simplifyStrokePoints,
} from './freehand.js';
import {
  COMMAND_NAMES,
  EXTENSION_ID,
  EXTENSION_MANIFEST,
  FREEHAND_TOOL_STATE,
  STROKE_ASPECT_ID,
  createPackageManifest,
  settingsSchema,
} from './manifest.js';
import { escapeAttr, renderStrokeDom, renderStrokeSvg } from './renderers.js';
import { createStrokeGpuContribution, createStrokeSelectionContribution } from './selection.js';
import { PRESET_NAMES, planFreehandChanges, registerFreehandTools, sanitizeStrokePatch } from './tools.js';

export const FREEHAND_ICON = Object.freeze({
  paths: Object.freeze([
    'm4 13.5 8.5-8.5 3 3-8.5 8.5L3 17.5z',
    'm10.5 7 3 3',
    'M11.5 17c1.6 0 2.2-1.2 3.6-1.2 1 0 1.6.5 2.4 1.2',
  ]),
});

export const SIMPLIFY_ICON = Object.freeze({
  paths: Object.freeze([
    'M3 15c3-8 5-8 8 0s5 8 6-10',
    'M3 15h2m11-10h2',
  ]),
});

const COMMAND_META = Object.freeze({
  'draw-tool': {
    title: '자유 드로잉 도구',
    summary: '필압·속도 감응 브러시로 캔버스에 자유곡선을 그립니다 (단축키 D).',
    keys: ['d'],
  },
  'insert-stroke': {
    title: '자유 드로잉 스트로크 추가',
    summary: '캔버스에 자유 드로잉 스트로크 엔티티를 즉시 추가합니다.',
  },
  'simplify-stroke': {
    title: '스트로크 포인트 경량화 (RDP)',
    summary: '선택된 스트로크의 포인트를 Ramer-Douglas-Peucker 알고리즘으로 경량화합니다.',
  },
  'smooth-stroke': {
    title: '스트로크 곡선 다듬기',
    summary: '선택된 스트로크의 손떨림 보정(Streamline)과 스무딩을 강화합니다.',
  },
  'toggle-close-stroke': {
    title: '스트로크 닫힌 도형 전환',
    summary: '선택된 스트로크의 시작점과 끝점을 연결하거나 해제합니다.',
  },
  'cycle-brush': {
    title: '브러시 종류 순환',
    summary: '선택된 스트로크의 브러시 종류(펜/모노라인/마커/형광펜)를 전환합니다.',
  },
});

const strokeSelectionContribution = createStrokeSelectionContribution();

export const freehandStrokeAspect = Object.freeze({
  id: STROKE_ASPECT_ID,
  label: '자유 드로잉',
  summary: metadata.summary,
  layout: true,
  paintOverflow: 32,
  selection: strokeSelectionContribution,
  paintBounds: derived =>
    derived?.inkBounds ?? {
      x: finiteOr(derived?.x, 0),
      y: finiteOr(derived?.y, 0),
      width: Math.max(1, finiteOr(derived?.width, DEFAULT_BASE_WIDTH)),
      height: Math.max(1, finiteOr(derived?.height, DEFAULT_BASE_HEIGHT)),
    },
  dependsOnCanonical: ['core.transform', 'core.bounds', STROKE_ASPECT_ID],
  dependsOnComputed: [],
  defaults: STROKE_DEFAULTS,
  derive: deriveStrokeGeometry,
  renderDom: renderStrokeDom,
  renderSvg: renderStrokeSvg,
  ui: {
    controls: [
      {
        id: 'drawing.freehand.brush.selection',
        kind: 'segmented',
        field: 'brush',
        label: '브러시',
        placement: 'selection-bar',
        options: [
          { label: '펜', value: 'pen' },
          { label: '모노라인', value: 'fine' },
          { label: '마커', value: 'marker' },
          { label: '형광펜', value: 'highlighter' },
        ],
      },
      {
        id: 'drawing.freehand.dash.selection',
        kind: 'segmented',
        field: 'dash',
        label: '선 스타일',
        placement: 'selection-bar',
        options: [
          { label: '실선', value: 'solid' },
          { label: '파선', value: 'dashed' },
          { label: '점선', value: 'dotted' },
        ],
      },
      {
        id: 'drawing.freehand.color.selection',
        kind: 'segmented',
        field: 'stroke',
        label: '잉크 색상',
        placement: 'selection-bar',
        options: [
          { label: '블랙', value: '#17181c', swatch: '#17181c' },
          { label: '블루', value: '#3182f6', swatch: '#3182f6' },
          { label: '레드', value: '#ef4444', swatch: '#ef4444' },
          { label: '그린', value: '#10b981', swatch: '#10b981' },
          { label: '앰버', value: '#f59e0b', swatch: '#f59e0b' },
          { label: '퍼플', value: '#8b5cf6', swatch: '#8b5cf6' },
        ],
      },
      {
        id: 'drawing.freehand.simplify.selection',
        kind: 'action',
        label: '포인트 경량화',
        icon: SIMPLIFY_ICON,
        commandSymbol: `${EXTENSION_ID}:simplify-stroke`,
        placement: 'selection-bar',
        requiresSelection: true,
      },
      {
        id: 'drawing.freehand.brush.inspector',
        kind: 'segmented',
        field: 'brush',
        label: '브러시 종류',
        section: '브러시 및 잉크',
        placement: 'inspector',
        options: [
          { label: '필압 펜', value: 'pen' },
          { label: '모노라인', value: 'fine' },
          { label: '마커', value: 'marker' },
          { label: '형광펜', value: 'highlighter' },
        ],
      },
      {
        id: 'drawing.freehand.stroke.inspector',
        kind: 'color',
        field: 'stroke',
        label: '잉크 색상',
        section: '브러시 및 잉크',
        placement: 'inspector',
      },
      {
        id: 'drawing.freehand.stroke.swatches',
        kind: 'segmented',
        field: 'stroke',
        label: '잉크 팔레트',
        section: '브러시 및 잉크',
        placement: 'inspector',
        options: [
          { label: '차콜', value: '#17181c', swatch: '#17181c' },
          { label: '블루', value: '#3182f6', swatch: '#3182f6' },
          { label: '레드', value: '#ef4444', swatch: '#ef4444' },
          { label: '에메랄드', value: '#10b981', swatch: '#10b981' },
          { label: '앰버', value: '#f59e0b', swatch: '#f59e0b' },
          { label: '바이올렛', value: '#8b5cf6', swatch: '#8b5cf6' },
          { label: '핑크', value: '#ec4899', swatch: '#ec4899' },
        ],
      },
      {
        id: 'drawing.freehand.strokeWidth.inspector',
        kind: 'slider',
        field: 'strokeWidth',
        label: '브러시 굵기',
        section: '브러시 및 잉크',
        placement: 'inspector',
        min: 1,
        max: 64,
        step: 1,
      },
      {
        id: 'drawing.freehand.dash.inspector',
        kind: 'segmented',
        field: 'dash',
        label: '선 종류',
        section: '브러시 및 잉크',
        placement: 'inspector',
        options: [
          { label: '실선', value: 'solid' },
          { label: '파선', value: 'dashed' },
          { label: '점선', value: 'dotted' },
        ],
      },
      {
        id: 'drawing.freehand.opacity.inspector',
        kind: 'slider',
        field: 'opacity',
        label: '불투명도',
        section: '브러시 및 잉크',
        placement: 'inspector',
        min: 0.05,
        max: 1,
        step: 0.05,
      },
      {
        id: 'drawing.freehand.thinning.inspector',
        kind: 'slider',
        field: 'thinning',
        label: '필압·속도 굵기 변화 (Thinning)',
        section: '스트로크 다이나믹스',
        placement: 'inspector',
        min: 0,
        max: 0.95,
        step: 0.05,
      },
      {
        id: 'drawing.freehand.streamline.inspector',
        kind: 'slider',
        field: 'streamline',
        label: '손떨림 보정 (Streamline)',
        section: '스트로크 다이나믹스',
        placement: 'inspector',
        min: 0,
        max: 0.95,
        step: 0.05,
      },
      {
        id: 'drawing.freehand.smoothing.inspector',
        kind: 'slider',
        field: 'smoothing',
        label: '외곽선 스무딩 (Smoothing)',
        section: '스트로크 다이나믹스',
        placement: 'inspector',
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        id: 'drawing.freehand.taperStart.inspector',
        kind: 'slider',
        field: 'taperStart',
        label: '시작 끝단 테이퍼',
        section: '스트로크 다이나믹스',
        placement: 'inspector',
        min: 0,
        max: 120,
        step: 2,
      },
      {
        id: 'drawing.freehand.taperEnd.inspector',
        kind: 'slider',
        field: 'taperEnd',
        label: '종료 끝단 테이퍼',
        section: '스트로크 다이나믹스',
        placement: 'inspector',
        min: 0,
        max: 120,
        step: 2,
      },
      {
        id: 'drawing.freehand.closed.inspector',
        kind: 'toggle',
        field: 'isClosed',
        label: '닫힌 도형 루프',
        section: '채우기 및 마감',
        placement: 'inspector',
      },
      {
        id: 'drawing.freehand.fill.inspector',
        kind: 'segmented',
        field: 'fill',
        label: '채우기 색상',
        section: '채우기 및 마감',
        placement: 'inspector',
        options: [
          { label: '없음', value: 'none' },
          { label: '블루', value: '#3182f6', swatch: '#3182f6' },
          { label: '그린', value: '#10b981', swatch: '#10b981' },
          { label: '앰버', value: '#f59e0b', swatch: '#f59e0b' },
          { label: '레드', value: '#ef4444', swatch: '#ef4444' },
          { label: '퍼플', value: '#8b5cf6', swatch: '#8b5cf6' },
        ],
      },
      {
        id: 'drawing.freehand.fillOpacity.inspector',
        kind: 'slider',
        field: 'fillOpacity',
        label: '채우기 불투명도',
        section: '채우기 및 마감',
        placement: 'inspector',
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        id: 'drawing.freehand.simplify.inspector',
        kind: 'action',
        label: '포인트 경량화 (RDP 최적화)',
        icon: SIMPLIFY_ICON,
        commandSymbol: `${EXTENSION_ID}:simplify-stroke`,
        section: '스트로크 최적화',
        placement: 'inspector',
        requiresSelection: true,
      },
      {
        id: 'drawing.freehand.smooth.inspector',
        kind: 'action',
        label: '곡선 다듬기 (Streamline 강화)',
        icon: FREEHAND_ICON,
        commandSymbol: `${EXTENSION_ID}:smooth-stroke`,
        section: '스트로크 최적화',
        placement: 'inspector',
        requiresSelection: true,
      },
    ],
  },
});

function safeGetService(context, serviceId) {
  try {
    return context?.services?.get?.(serviceId);
  } catch {
    return undefined;
  }
}

function getSelectionService(context) {
  try {
    const fromApi = context?.getExtensionApi?.('core.select-suite');
    if (fromApi) return fromApi;
  } catch {
    // Ignore when optional provider is not registered
  }
  return safeGetService(context, 'canvas.selection');
}

function getActiveSurface(context) {
  return safeGetService(context, 'canvas.active-tool-surface')?.get?.() ?? null;
}

function getSelectedStrokeIds(context, explicitEntityId) {
  if (typeof explicitEntityId === 'string' && explicitEntityId) {
    return context?.world?.getCanonical?.(explicitEntityId, STROKE_ASPECT_ID) ? [explicitEntityId] : [];
  }
  const surface = getActiveSurface(context);
  const selectionService = surface?.selection ?? getSelectionService(context);
  const selected = selectionService?.getSelection?.() ?? [];
  return selected.filter(id => Boolean(context?.world?.getCanonical?.(id, STROKE_ASPECT_ID)));
}

function withHistoryGroup(context, fn) {
  const history = getActiveSurface(context)?.host?.history;
  history?.begin?.();
  try {
    const result = fn();
    history?.commit?.();
    return result;
  } catch (error) {
    history?.abort?.();
    throw error;
  }
}

function readPreference(context, key, fallback) {
  try {
    const prefs = safeGetService(context, 'extensions.preferences');
    const val = prefs?.get?.(key);
    return val !== undefined ? val : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(context, key, value) {
  try {
    const prefs = safeGetService(context, 'extensions.preferences');
    prefs?.set?.(key, value);
  } catch {
    // Ignore when preferences service is read-only or unavailable
  }
}

export default {
  ...createPackageManifest(metadata),
  summary: metadata.summary,
  aspects: [freehandStrokeAspect],
  ui: {
    controls: [
      {
        id: 'drawing.freehand.tool.shelf',
        kind: 'action',
        label: '자유 드로잉',
        mnemonic: 'd',
        icon: FREEHAND_ICON,
        commandSymbol: `${EXTENSION_ID}:draw-tool`,
        placement: 'tool-shelf',
        requiresSelection: false,
        activeToolState: FREEHAND_TOOL_STATE,
      },
    ],
  },
  activate(context) {
    const creation = safeGetService(context, 'canvas.creation');
    if (!creation) {
      throw new Error('자유 드로잉 확장에는 canvas.creation 호스트 서비스가 필요합니다.');
    }

    let active = true;
    const ensureActive = () => {
      if (!active) {
        throw new Error('자유 드로잉 확장이 비활성화되었습니다. 공개 API를 다시 조회하세요.');
      }
    };

    const disposers = [];
    const selectionService = getSelectionService(context);
    if (typeof selectionService?.registerContribution === 'function') {
      disposers.push(selectionService.registerContribution(createStrokeSelectionContribution()));
    }

    const gpuContributions = safeGetService(context, 'canvas.gpu-contributions');
    if (typeof gpuContributions?.register === 'function') {
      disposers.push(gpuContributions.register(createStrokeGpuContribution()));
    }

    const frames = safeGetService(context, 'canvas.frames');
    const toolInput = safeGetService(context, 'canvas.tool-input');
    const activeSurface = safeGetService(context, 'canvas.active-tool-surface');

    const resolveToolEndpoints = () => {
      const active = activeSurface?.get?.() ?? null;
      const rawSurface = active?.surface ?? safeGetService(context, 'canvas.surface') ?? null;
      const surfaceElement = rawSurface?.element ?? rawSurface ?? null;
      const hudElement = active?.hud ?? rawSurface?.hud ?? null;
      const host = active?.host ?? safeGetService(context, 'canvas.interaction') ?? null;
      const selection = active?.selection ?? getSelectionService(context) ?? null;
      return {
        surface: surfaceElement,
        hud: hudElement,
        host,
        selection,
      };
    };

    let currentTool = null;
    let boundEndpoints = null;
    let disposeSurfaceTool = () => {};

    const syncSurfaceTool = explicitTarget => {
      const next =
        explicitTarget && typeof explicitTarget === 'object' && ('surface' in explicitTarget || 'selection' in explicitTarget)
          ? {
              surface: explicitTarget.surface?.element ?? explicitTarget.surface ?? null,
              hud: explicitTarget.hud ?? explicitTarget.surface?.hud ?? null,
              host: explicitTarget.host ?? safeGetService(context, 'canvas.interaction') ?? null,
              selection: explicitTarget.selection ?? getSelectionService(context) ?? null,
            }
          : resolveToolEndpoints();

      if (
        currentTool
        && boundEndpoints
        && boundEndpoints.surface === next.surface
        && boundEndpoints.hud === next.hud
        && boundEndpoints.host === next.host
        && boundEndpoints.selection === next.selection
      ) {
        return currentTool;
      }

      const wasActive =
        Boolean(currentTool?.active)
        || getMachineStateId(boundEndpoints?.selection?.stateMachine) === FREEHAND_TOOL_STATE;

      disposeSurfaceTool();
      disposeSurfaceTool = () => {};
      currentTool = null;
      boundEndpoints = null;

      if (!next.surface || !next.hud) return null;

      const tool = new FreeDrawTool({
        world: context.world,
        creation,
        surface: next.surface,
        hud: next.hud,
        host: next.host,
        selection: next.selection,
        getPreference: (key, fallback) => readPreference(context, key, fallback),
        setPreference: (key, value) => writePreference(context, key, value),
      });

      const unmountEvents = tool.mount();
      const unmountState =
        next.selection?.stateMachine?.mountChildState?.('root.select', tool.createStateNode()) ?? (() => {});
      const offFrames = frames?.subscribe?.(() => tool.flushFrame()) ?? (() => {});

      currentTool = tool;
      boundEndpoints = next;
      disposeSurfaceTool = () => {
        if (getMachineStateId(next.selection?.stateMachine) === FREEHAND_TOOL_STATE) {
          transitionMachineToIdle(next.selection.stateMachine);
        }
        offFrames();
        unmountState();
        unmountEvents();
        tool.dispose();
        currentTool = null;
        boundEndpoints = null;
      };

      if (wasActive) {
        tool.enter();
      }
      return tool;
    };

    syncSurfaceTool();
    if (typeof activeSurface?.subscribe === 'function') {
      const offSub = activeSurface.subscribe(next => syncSurfaceTool(next));
      disposers.push(() => {
        offSub();
        disposeSurfaceTool();
      });
    } else {
      disposers.push(() => disposeSurfaceTool());
    }

    if (typeof toolInput?.register === 'function') {
      const handler = {
        handleKeyDown: event => currentTool?.onKeyDown?.(event) ?? false,
        onEscape: () => {
          const machine = (getActiveSurface(context)?.selection ?? selectionService)?.stateMachine;
          if (getMachineStateId(machine) !== FREEHAND_TOOL_STATE) return false;
          return machine.dispatch({ type: 'escape' });
        },
        onBlur: () => {
          currentTool?.onWindowBlur?.();
        },
      };
      const offToolInput =
        toolInput.register.length >= 2
          ? toolInput.register(EXTENSION_ID, handler)
          : toolInput.register(EXTENSION_ID, handler) ?? toolInput.register(handler);
      if (typeof offToolInput === 'function') {
        disposers.push(offToolInput);
      }
    }

    const insertStroke = (options = {}) => {
      ensureActive();
      const presetData = options.preset ? createPresetStroke(options.preset) : null;
      const defaultBrush = normalizeBrush(
        options.brush ?? readPreference(context, 'defaultBrush', STROKE_DEFAULTS.brush),
        STROKE_DEFAULTS.brush,
      );
      const defaultStroke = sanitizeColor(
        options.stroke ?? readPreference(context, 'defaultStroke', STROKE_DEFAULTS.stroke),
        STROKE_DEFAULTS.stroke,
      );
      const defaultWidth = clamp(
        finiteOr(
          Number(options.strokeWidth ?? readPreference(context, 'defaultStrokeWidth', STROKE_DEFAULTS.strokeWidth)),
          STROKE_DEFAULTS.strokeWidth,
        ),
        1,
        64,
      );
      const defaultStreamline = clamp(
        finiteOr(
          Number(options.streamline ?? readPreference(context, 'defaultStreamline', STROKE_DEFAULTS.streamline)),
          STROKE_DEFAULTS.streamline,
        ),
        0,
        0.95,
      );

      let normalized = null;
      if (Array.isArray(options.points) && options.points.length > 0) {
        normalized = normalizeStrokeGeometry(options.points, {
          simplifyTolerance: finiteOr(Number(options.simplifyTolerance), 0),
        });
      }

      const baseWidth = normalized?.baseWidth ?? presetData?.baseWidth ?? DEFAULT_BASE_WIDTH;
      const baseHeight = normalized?.baseHeight ?? presetData?.baseHeight ?? DEFAULT_BASE_HEIGHT;

      const props = {
        ...STROKE_DEFAULTS,
        ...(presetData ?? {}),
        brush: presetData?.brush && !options.brush ? presetData.brush : defaultBrush,
        stroke: presetData?.stroke && !options.stroke ? presetData.stroke : defaultStroke,
        strokeWidth: presetData?.strokeWidth && !options.strokeWidth ? presetData.strokeWidth : defaultWidth,
        streamline: defaultStreamline,
        dash: normalizeDash(options.dash ?? STROKE_DEFAULTS.dash),
        thinning: clamp(finiteOr(Number(options.thinning), STROKE_DEFAULTS.thinning), 0, 0.95),
        smoothing: clamp(finiteOr(Number(options.smoothing), STROKE_DEFAULTS.smoothing), 0, 1),
        taperStart: clamp(finiteOr(Number(options.taperStart), STROKE_DEFAULTS.taperStart), 0, 120),
        taperEnd: clamp(finiteOr(Number(options.taperEnd), STROKE_DEFAULTS.taperEnd), 0, 120),
        fill: sanitizeColor(options.fill ?? STROKE_DEFAULTS.fill, STROKE_DEFAULTS.fill),
        fillOpacity: clamp(finiteOr(Number(options.fillOpacity), STROKE_DEFAULTS.fillOpacity), 0, 1),
        opacity: clamp(finiteOr(Number(options.opacity), STROKE_DEFAULTS.opacity), 0.05, 1),
        isClosed: Boolean(options.isClosed ?? presetData?.isClosed ?? STROKE_DEFAULTS.isClosed),
        isPen: Boolean(options.isPen ?? STROKE_DEFAULTS.isPen),
        points: normalized?.points ?? presetData?.points ?? STROKE_DEFAULTS.points,
        segments: normalized?.segments ?? presetData?.segments ?? STROKE_DEFAULTS.segments,
        baseWidth,
        baseHeight,
      };

      const width = Math.max(1, finiteOr(Number(options.width), normalized?.width ?? baseWidth));
      const height = Math.max(1, finiteOr(Number(options.height), normalized?.height ?? baseHeight));
      const caller = options.caller ?? `${EXTENSION_ID}:insert-stroke`;

      const createPayload = {
        caller,
        aspects: {
          [STROKE_ASPECT_ID]: props,
        },
        width,
        height,
      };
      if (Number.isFinite(options.x)) createPayload.x = Number(options.x);
      else if (normalized && Number.isFinite(normalized.x) && Array.isArray(options.points)) createPayload.x = normalized.x;
      if (Number.isFinite(options.y)) createPayload.y = Number(options.y);
      else if (normalized && Number.isFinite(normalized.y) && Array.isArray(options.points)) createPayload.y = normalized.y;

      const createdId = creation.create(createPayload);
      const sel = getActiveSurface(context)?.selection ?? selectionService;
      sel?.select?.(createdId);
      return createdId;
    };

    const toggleDrawTool = () => {
      ensureActive();
      syncSurfaceTool();
      const endpoints = resolveToolEndpoints();
      const machine = endpoints.selection?.stateMachine;
      const isCurrentlyActive =
        Boolean(currentTool?.active)
        || getMachineStateId(machine) === FREEHAND_TOOL_STATE;

      if (isCurrentlyActive) {
        if (currentTool) {
          return currentTool.exit();
        }
        return transitionMachineToIdle(machine);
      }

      if (context?.commands?.get?.('canvas:select-tool')) {
        context.commands.execute('canvas:select-tool');
        syncSurfaceTool();
      }

      if (currentTool) {
        return currentTool.enter();
      }

      if (machine && typeof machine.transition === 'function') {
        endpoints.selection?.select?.(null);
        endpoints.selection?.clear?.();
        machine.transition(FREEHAND_TOOL_STATE);
      }
      return FREEHAND_TOOL_STATE;
    };

    const simplifySelectedStrokes = (options = {}) => {
      ensureActive();
      const ids = getSelectedStrokeIds(context, options.entityId);
      if (ids.length === 0) return [];
      const tolerance = clamp(
        finiteOr(
          Number(options.tolerance ?? readPreference(context, 'simplifyTolerance', 1.2)),
          1.2,
        ),
        0.1,
        12,
      );
      return withHistoryGroup(context, () => {
        for (const id of ids) {
          const props = context.world.getCanonical(id, STROKE_ASPECT_ID);
          if (!props || !Array.isArray(props.points) || props.points.length <= 3) continue;
          const simplified = simplifyStrokePoints(props.points, tolerance);
          context.world.setCanonical(id, STROKE_ASPECT_ID, {
            ...props,
            points: simplified.map(p => ({ x: round2(p.x), y: round2(p.y), z: round3(p.z ?? 0.5) })),
          });
        }
        return ids;
      });
    };

    const smoothSelectedStrokes = (options = {}) => {
      ensureActive();
      const ids = getSelectedStrokeIds(context, options.entityId);
      if (ids.length === 0) return [];
      return withHistoryGroup(context, () => {
        for (const id of ids) {
          const props = context.world.getCanonical(id, STROKE_ASPECT_ID);
          if (!props) continue;
          const nextStreamline = clamp(round2(finiteOr(Number(props.streamline), 0.5) + 0.15), 0, 0.95);
          const nextSmoothing = clamp(round2(finiteOr(Number(props.smoothing), 0.5) + 0.15), 0, 1);
          context.world.setCanonical(id, STROKE_ASPECT_ID, {
            ...props,
            streamline: nextStreamline,
            smoothing: nextSmoothing,
          });
        }
        return ids;
      });
    };

    const toggleCloseSelectedStrokes = (options = {}) => {
      ensureActive();
      const ids = getSelectedStrokeIds(context, options.entityId);
      if (ids.length === 0) return [];
      return withHistoryGroup(context, () => {
        for (const id of ids) {
          const props = context.world.getCanonical(id, STROKE_ASPECT_ID);
          if (!props) continue;
          context.world.setCanonical(id, STROKE_ASPECT_ID, {
            ...props,
            isClosed: options.isClosed !== undefined ? Boolean(options.isClosed) : !props.isClosed,
          });
        }
        return ids;
      });
    };

    const cycleBrushOnSelectedStrokes = (options = {}) => {
      ensureActive();
      const ids = getSelectedStrokeIds(context, options.entityId);
      if (ids.length === 0) return [];
      return withHistoryGroup(context, () => {
        for (const id of ids) {
          const props = context.world.getCanonical(id, STROKE_ASPECT_ID);
          if (!props) continue;
          const currentIdx = BRUSH_TYPES.indexOf(props.brush ?? 'pen');
          const nextBrush = options.brush && BRUSH_TYPES.includes(options.brush)
            ? options.brush
            : BRUSH_TYPES[(currentIdx + 1) % BRUSH_TYPES.length];
          context.world.setCanonical(id, STROKE_ASPECT_ID, {
            ...props,
            brush: nextBrush,
          });
        }
        return ids;
      });
    };

    const commandHandlers = {
      'draw-tool': toggleDrawTool,
      'insert-stroke': insertStroke,
      'simplify-stroke': simplifySelectedStrokes,
      'smooth-stroke': smoothSelectedStrokes,
      'toggle-close-stroke': toggleCloseSelectedStrokes,
      'cycle-brush': cycleBrushOnSelectedStrokes,
    };

    for (const name of COMMAND_NAMES) {
      const meta = COMMAND_META[name];
      const offCmd = context.commands.register({
        id: `${EXTENSION_ID}:${name}`,
        title: meta.title,
        summary: meta.summary,
        shortcutScope: 'canvas',
        ...(meta.keys ? { keys: meta.keys } : {}),
        run: (args = {}) => commandHandlers[name](args),
      });
      disposers.push(offCmd);
    }

    disposers.push(registerFreehandTools(context));

    const api = Object.freeze({
      insertStroke,
      addStroke: insertStroke,
      toggleDrawTool,
      simplifySelectedStrokes,
      smoothSelectedStrokes,
      toggleCloseSelectedStrokes,
      cycleBrushOnSelectedStrokes,
      getActiveTool: () => currentTool,
      run(commandName, args = {}) {
        ensureActive();
        const fn = commandHandlers[commandName];
        if (!fn) throw new Error(`Unknown command: ${commandName}`);
        return fn(args);
      },
    });

    return {
      api,
      dispose() {
        if (!active) return;
        active = false;
        for (const off of disposers.splice(0).reverse()) {
          try {
            off();
          } catch {
            // Ignore individual cleanup errors
          }
        }
      },
    };
  },
};

export {
  BRUSH_TYPES,
  COMMAND_NAMES,
  DASH_TYPES,
  EXTENSION_ID,
  EXTENSION_MANIFEST,
  FREEHAND_TOOL_STATE,
  PRESET_NAMES,
  STROKE_ASPECT_ID,
  STROKE_DEFAULTS,
  createPackageManifest,
  createPresetStroke,
  createStrokeGpuContribution,
  createStrokeSelectionContribution,
  deriveStrokeGeometry,
  escapeAttr,
  getStrokeOutlinePoints,
  getStrokePoints,
  getSvgPathFromStrokePoints,
  normalizeStrokeGeometry,
  planFreehandChanges,
  registerFreehandTools,
  renderStrokeDom,
  renderStrokeSvg,
  resolveStrokeStyle,
  sanitizeStrokePatch,
  settingsSchema,
  simplifyStrokePoints,
};
