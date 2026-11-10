import rawConfig from '../extension.json' with { type: 'json' };

export const EXTENSION_ID = rawConfig.id;
export const STROKE_ASPECT_ID = `${EXTENSION_ID}.stroke`;
export const FREEHAND_TOOL_STATE = `root.select.${EXTENSION_ID}`;

export const COMMAND_NAMES = Object.freeze([
  'draw-tool',
  'insert-stroke',
  'simplify-stroke',
  'smooth-stroke',
  'toggle-close-stroke',
  'cycle-brush',
]);

export const settingsSchema = Object.freeze([
  {
    key: 'defaultBrush',
    label: '기본 브러시 종류',
    kind: 'select',
    defaultValue: 'pen',
    options: [
      { value: 'pen', label: '필압 펜 (가변 굵기)' },
      { value: 'fine', label: '정밀 모노라인 펜' },
      { value: 'marker', label: '캘리그래피 마커' },
      { value: 'highlighter', label: '형광펜 (반투명)' },
    ],
  },
  {
    key: 'defaultStroke',
    label: '기본 잉크 색상',
    kind: 'select',
    defaultValue: '#17181c',
    options: [
      { value: '#17181c', label: '차콜 블랙 (#17181c)' },
      { value: '#3182f6', label: '블루 (#3182f6)' },
      { value: '#ef4444', label: '레드 (#ef4444)' },
      { value: '#10b981', label: '에메랄드 (#10b981)' },
      { value: '#f59e0b', label: '앰버 (#f59e0b)' },
      { value: '#8b5cf6', label: '바이올렛 (#8b5cf6)' },
    ],
  },
  {
    key: 'defaultStrokeWidth',
    label: '기본 브러시 굵기',
    kind: 'number',
    defaultValue: 15,
    min: 1,
    max: 64,
    step: 1,
  },
  {
    key: 'defaultStreamline',
    label: '기본 손떨림 보정 (Streamline)',
    kind: 'number',
    defaultValue: 0.5,
    min: 0,
    max: 0.95,
    step: 0.05,
  },
  {
    key: 'simplifyTolerance',
    label: '포인트 경량화 허용 오차 (RDP)',
    kind: 'number',
    defaultValue: 0.65,
    min: 0,
    max: 4,
    step: 0.05,
  },
  {
    key: 'keepToolActive',
    label: '연속 드로잉 모드 (획 완료 후 도구 유지)',
    kind: 'boolean',
    defaultValue: true,
  },
]);

/** Shared by the bundle and build script; keep the reviewed and executed contracts identical. */
export function createPackageManifest(metadata = rawConfig) {
  return {
    id: metadata.id,
    settingsSchema,
    version: metadata.version,
    engine: metadata.engine,
    dependencies: { ...metadata.dependencies },
    optionalDependencies: { ...metadata.optionalDependencies },
    conflicts: [...metadata.conflicts],
    provides: {
      services: [...metadata.provides.services],
      aspects: [`${metadata.id}.stroke`],
      hsmSlots: [...metadata.provides.hsmSlots],
    },
  };
}

export const EXTENSION_MANIFEST = Object.freeze(createPackageManifest(rawConfig));
