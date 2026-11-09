import {
  BRUSH_TYPES,
  DASH_TYPES,
  DEFAULT_BASE_HEIGHT,
  DEFAULT_BASE_WIDTH,
  MIN_STROKE_DIMENSION,
  STROKE_DEFAULTS,
  clamp,
  createPresetStroke,
  finiteOr,
  isValidHexColor,
  normalizeStrokeGeometry,
  round2,
  round3,
} from './freehand.js';
import { EXTENSION_ID, STROKE_ASPECT_ID } from './manifest.js';

export const PRESET_NAMES = Object.freeze([
  'wave',
  'circle',
  'box',
  'underline',
  'highlight',
  'check',
  'arrow',
  'spiral',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeStrokePatch(rawPatch, existingProps = STROKE_DEFAULTS) {
  if (!isPlainObject(rawPatch)) {
    throw new Error('INVALID_INPUT: patch must be a JSON object');
  }
  const clean = {};

  if (rawPatch.preset !== undefined) {
    if (typeof rawPatch.preset !== 'string' || !PRESET_NAMES.includes(rawPatch.preset)) {
      throw new Error(`INVALID_INPUT: preset must be one of ${PRESET_NAMES.join(', ')}`);
    }
    const preset = createPresetStroke(rawPatch.preset);
    clean.points = preset.points;
    clean.segments = preset.segments;
    clean.baseWidth = preset.baseWidth;
    clean.baseHeight = preset.baseHeight;
    clean.isClosed = preset.isClosed;
    if (preset.brush) clean.brush = preset.brush;
    if (preset.stroke) clean.stroke = preset.stroke;
    if (preset.strokeWidth) clean.strokeWidth = preset.strokeWidth;
  }

  if (rawPatch.points !== undefined) {
    if (!Array.isArray(rawPatch.points) || rawPatch.points.length === 0 || rawPatch.points.length > 8192) {
      throw new Error('INVALID_INPUT: points must be a non-empty array of {x, y, z?} objects (max 8192)');
    }
    const validated = [];
    for (let i = 0; i < rawPatch.points.length; i++) {
      const pt = rawPatch.points[i];
      if (!isPlainObject(pt) || !Number.isFinite(Number(pt.x)) || !Number.isFinite(Number(pt.y))) {
        throw new Error(`INVALID_INPUT: points[${i}] requires finite x and y numbers`);
      }
      validated.push({
        x: round2(Number(pt.x)),
        y: round2(Number(pt.y)),
        z: round3(clamp(finiteOr(Number(pt.z), 0.5), 0.01, 1)),
        ...(pt.seg === 1 || pt.segment === 'straight' ? { seg: 1 } : {}),
      });
    }
    const normalized = normalizeStrokeGeometry(validated, {
      simplifyTolerance: finiteOr(Number(rawPatch.simplifyTolerance), 0),
    });
    clean.points = normalized.points;
    clean.segments = normalized.segments;
    clean.baseWidth = normalized.baseWidth;
    clean.baseHeight = normalized.baseHeight;
  }

  if (rawPatch.brush !== undefined) {
    if (!BRUSH_TYPES.includes(rawPatch.brush)) {
      throw new Error(`INVALID_INPUT: brush must be one of ${BRUSH_TYPES.join(', ')}`);
    }
    clean.brush = rawPatch.brush;
  }

  if (rawPatch.dash !== undefined) {
    if (!DASH_TYPES.includes(rawPatch.dash)) {
      throw new Error(`INVALID_INPUT: dash must be one of ${DASH_TYPES.join(', ')}`);
    }
    clean.dash = rawPatch.dash;
  }

  if (rawPatch.stroke !== undefined) {
    if (!isValidHexColor(rawPatch.stroke)) {
      throw new Error('INVALID_INPUT: stroke must be a #rrggbb hex color');
    }
    clean.stroke = rawPatch.stroke.trim();
  }

  if (rawPatch.fill !== undefined) {
    if (rawPatch.fill !== 'none' && rawPatch.fill !== 'transparent' && !isValidHexColor(rawPatch.fill)) {
      throw new Error('INVALID_INPUT: fill must be "none", "transparent", or a #rrggbb hex color');
    }
    clean.fill = rawPatch.fill.trim();
  }

  for (const [key, min, max] of [
    ['strokeWidth', 1, 64],
    ['thinning', 0, 0.95],
    ['streamline', 0, 0.95],
    ['smoothing', 0, 1],
    ['taperStart', 0, 120],
    ['taperEnd', 0, 120],
    ['fillOpacity', 0, 1],
    ['opacity', 0.05, 1],
  ]) {
    if (rawPatch[key] !== undefined) {
      const num = Number(rawPatch[key]);
      if (!Number.isFinite(num) || num < min || num > max) {
        throw new Error(`INVALID_INPUT: ${key} must be a number between ${min} and ${max}`);
      }
      clean[key] = round3(num);
    }
  }

  for (const boolKey of ['isClosed', 'isPen']) {
    if (rawPatch[boolKey] !== undefined) {
      if (typeof rawPatch[boolKey] !== 'boolean') {
        throw new Error(`INVALID_INPUT: ${boolKey} must be a boolean`);
      }
      clean[boolKey] = rawPatch[boolKey];
    }
  }

  if (clean.baseWidth === undefined && existingProps?.baseWidth) {
    clean.baseWidth = existingProps.baseWidth;
  }
  if (clean.baseHeight === undefined && existingProps?.baseHeight) {
    clean.baseHeight = existingProps.baseHeight;
  }

  return clean;
}

/**
 * Plans a batch of freehand stroke operations into `CanonicalPatchOp[]` without mutating the world.
 */
export function planFreehandChanges(world, actions) {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 50) {
    throw new Error('INVALID_INPUT: actions must be a non-empty array of at most 50 items');
  }

  const snapshot = world.exportCanonicalSnapshot?.() ?? {};
  const aliases = new Map();
  const ops = [];

  for (const action of actions) {
    if (!isPlainObject(action)) throw new Error('INVALID_INPUT: each action must be an object');
    if (action.action === 'create') {
      if (action.id !== undefined) {
        if (typeof action.id !== 'string' || !action.id.trim() || aliases.has(action.id) || Object.hasOwn(snapshot, action.id)) {
          throw new Error('INVALID_INPUT: duplicate or invalid create alias');
        }
      }
      const generatedId = `freehand-${crypto.randomUUID()}`;
      aliases.set(action.id ?? generatedId, generatedId);
    }
  }

  let createSeq = 0;
  const createdIds = [...aliases.values()];
  const resolveId = rawId => aliases.get(rawId) ?? rawId;

  for (const action of actions) {
    const kind = action.action;
    if (!['create', 'update', 'move', 'delete'].includes(kind)) {
      throw new Error(`INVALID_INPUT: unsupported action "${String(kind)}"`);
    }

    const id = kind === 'create' ? createdIds[createSeq++] : resolveId(action.id);
    if (typeof id !== 'string' || !id) {
      throw new Error('INVALID_INPUT: missing target entity id');
    }

    if (kind !== 'create') {
      const alive = world.isAlive ? world.isAlive(id) : Boolean(snapshot[id]);
      const hasStroke = Boolean(world.getCanonical?.(id, STROKE_ASPECT_ID) ?? snapshot[id]?.[STROKE_ASPECT_ID]);
      if (!alive || !hasStroke) {
        throw new Error(`INVALID_INPUT: freehand stroke entity "${id}" does not exist`);
      }
    }

    if (kind === 'delete') {
      ops.push({ id, aspect: STROKE_ASPECT_ID, patch: null });
      continue;
    }

    if (kind === 'move') {
      if (action.x !== undefined || action.y !== undefined) {
        const currentTransform = world.getCanonical?.(id, 'core.transform') ?? { x: 0, y: 0, rotation: 0 };
        const x = action.x !== undefined ? Number(action.x) : currentTransform.x;
        const y = action.y !== undefined ? Number(action.y) : currentTransform.y;
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) {
          throw new Error('INVALID_INPUT: invalid x/y coordinates');
        }
        ops.push({ id, aspect: 'core.transform', patch: { x: round2(x), y: round2(y) } });
      }
      if (action.width !== undefined || action.height !== undefined) {
        const currentBounds = world.getCanonical?.(id, 'core.bounds') ?? {
          width: DEFAULT_BASE_WIDTH,
          height: DEFAULT_BASE_HEIGHT,
        };
        const width = action.width !== undefined ? Number(action.width) : currentBounds.width;
        const height = action.height !== undefined ? Number(action.height) : currentBounds.height;
        if (
          !Number.isFinite(width)
          || !Number.isFinite(height)
          || width < MIN_STROKE_DIMENSION
          || height < MIN_STROKE_DIMENSION
          || width > 8000
          || height > 8000
        ) {
          throw new Error('INVALID_INPUT: invalid width/height bounds');
        }
        ops.push({ id, aspect: 'core.bounds', patch: { width: round2(width), height: round2(height) } });
      }
      continue;
    }

    const existing =
      kind === 'update'
        ? (world.getCanonical?.(id, STROKE_ASPECT_ID) ?? STROKE_DEFAULTS)
        : STROKE_DEFAULTS;
    const sanitized = sanitizeStrokePatch(action.patch ?? {}, existing);
    const merged = {
      ...(kind === 'create' ? STROKE_DEFAULTS : existing),
      ...sanitized,
    };

    if (kind === 'create') {
      const x = action.x !== undefined ? Number(action.x) : 120;
      const y = action.y !== undefined ? Number(action.y) : 120;
      const width = action.width !== undefined ? Number(action.width) : merged.baseWidth ?? DEFAULT_BASE_WIDTH;
      const height = action.height !== undefined ? Number(action.height) : merged.baseHeight ?? DEFAULT_BASE_HEIGHT;

      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) {
        throw new Error('INVALID_INPUT: invalid create x/y coordinates');
      }
      if (
        !Number.isFinite(width)
        || !Number.isFinite(height)
        || width < MIN_STROKE_DIMENSION
        || height < MIN_STROKE_DIMENSION
      ) {
        throw new Error('INVALID_INPUT: invalid create width/height bounds');
      }
      ops.push({ id, aspect: 'core.transform', patch: { x: round2(x), y: round2(y), rotation: 0 } });
      ops.push({ id, aspect: 'core.bounds', patch: { width: round2(width), height: round2(height) } });
      ops.push({ id, aspect: STROKE_ASPECT_ID, patch: merged });
    } else {
      ops.push({ id, aspect: STROKE_ASPECT_ID, patch: sanitized });
    }
  }

  if (ops.length > 150) {
    throw new Error('INVALID_INPUT: operation budget exceeded');
  }
  return ops;
}

/**
 * Registers `drawing.freehand` read & proposal tools with the host `workspace.tools` service.
 */
export function registerFreehandTools(context) {
  const tools = context?.services?.get?.('workspace.tools');
  if (!tools) return () => {};

  const { world } = context;
  const disposers = [];

  const registerTool = (name, description, properties, required, execute) => {
    disposers.push(
      tools.register({
        id: `${EXTENSION_ID}:${name}`,
        description,
        inputSchema: {
          type: 'object',
          properties,
          required,
        },
        execute: async (input, meta) => {
          meta?.signal?.throwIfAborted?.();
          return execute(input ?? {});
        },
      }),
    );
  };

  try {
    if (typeof tools.registerDescriptor === 'function') {
      disposers.push(
        tools.registerDescriptor({
          aspect: STROKE_ASPECT_ID,
          description:
            '고성능 필압·속도 감응 자유 드로잉 스트로크 도형. 생성·수정·이동·삭제는 plan-changes 도구를 통해 사용자 승인 제안(prepareChange)으로 수행하세요.',
          fields: {
            brush: `Allowed: ${BRUSH_TYPES.join(', ')}`,
            dash: `Allowed: ${DASH_TYPES.join(', ')}`,
            stroke: 'string (#rrggbb): 잉크 색상',
            strokeWidth: 'number (1–64): 브러시 굵기',
            thinning: 'number (0–0.95): 필압/속도 기반 가변 굵기 민감도 (0이면 일정한 굵기)',
            streamline: 'number (0–0.95): 스트림라인 손떨림 보정 강도',
            smoothing: 'number (0–1): 외곽선 폴리곤 보간 강도',
            taperStart: 'number (0–120): 시작 끝단 테이퍼 길이',
            taperEnd: 'number (0–120): 종료 끝단 테이퍼 길이',
            fill: 'string ("none" | "#rrggbb"): 닫힌 스트로크 채우기 색상',
            fillOpacity: 'number (0–1): 채우기 불투명도',
            opacity: 'number (0.05–1): 스트로크 전체 불투명도',
            isClosed: 'boolean: 시작점과 끝점을 닫힌 루프로 연결할지 여부',
            points: 'array of {x, y, z}: 정규화된 로컬 스트로크 좌표 배열',
          },
        }),
      );
    }

    registerTool(
      'presets',
      '자유 드로잉 브러시 모드, 선 스타일, 프리셋 스트로크 목록 조회 (읽기 전용).',
      {},
      [],
      () => ({
        brushes: BRUSH_TYPES.map(id => ({
          id,
          description:
            id === 'pen'
              ? '필압·속도 감응 가변 굵기 펜'
              : id === 'fine'
                ? '일정한 굵기의 정밀 모노라인 펜'
                : id === 'marker'
                  ? '강한 굵기 대비의 캘리그래피 마커'
                  : '반투명 형광펜 브러시',
        })),
        dashes: DASH_TYPES,
        presets: PRESET_NAMES,
      }),
    );

    registerTool(
      'search',
      '현재 캔버스의 자유 드로잉 스트로크 엔티티 목록과 브러시·포인트 요약 조회 (읽기 전용).',
      {
        brush: { type: 'string' },
      },
      [],
      ({ brush = '' }) => {
        const filterBrush = String(brush ?? '').trim();
        const entities = [];
        for (const id of world.listEntityIds?.() ?? []) {
          if (world.isAlive && !world.isAlive(id)) continue;
          const props = world.getCanonical?.(id, STROKE_ASPECT_ID);
          if (!props) continue;
          if (filterBrush && props.brush !== filterBrush) continue;
          entities.push({
            id,
            brush: props.brush ?? STROKE_DEFAULTS.brush,
            stroke: props.stroke ?? STROKE_DEFAULTS.stroke,
            strokeWidth: props.strokeWidth ?? STROKE_DEFAULTS.strokeWidth,
            dash: props.dash ?? STROKE_DEFAULTS.dash,
            isClosed: Boolean(props.isClosed),
            pointCount: Array.isArray(props.points) ? props.points.length : 0,
            transform: world.getCanonical?.(id, 'core.transform'),
            bounds: world.getCanonical?.(id, 'core.bounds'),
          });
        }
        return { total: entities.length, entities };
      },
    );

    registerTool(
      'plan-changes',
      '자유 드로잉 스트로크 생성·수정·이동·삭제 승인 제안 생성. actions는 JSON 배열 문자열입니다: [{"action":"create","id":"s1","x":120,"y":120,"patch":{"preset":"wave","brush":"pen","stroke":"#3182f6","strokeWidth":8}},{"action":"update","id":"existing-id","patch":{"brush":"highlighter","stroke":"#f59e0b"}},{"action":"move","id":"existing-id","x":200,"y":180,"width":240,"height":120},{"action":"delete","id":"existing-id"}]. 직접 적용하지 않고 사용자 승인 제안을 반환합니다.',
      {
        actions: { type: 'string' },
      },
      ['actions'],
      ({ actions }) => {
        if (typeof tools.prepareChange !== 'function') {
          throw new Error('Host update required: workspace.tools.prepareChange is unavailable');
        }
        let parsedActions;
        try {
          parsedActions = JSON.parse(actions);
        } catch (error) {
          throw new Error(
            `INVALID_INPUT: actions must be valid JSON (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        const ops = planFreehandChanges(world, parsedActions);
        return tools.prepareChange(ops);
      },
    );
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // Ignore cleanup failure
      }
    }
    throw error;
  }

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // Ignore cleanup failure
      }
    }
  };
}
