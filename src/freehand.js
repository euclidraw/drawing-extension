import { STROKE_ASPECT_ID } from './manifest.js';

export const BRUSH_TYPES = Object.freeze(['pen', 'fine', 'marker', 'highlighter']);
export const DASH_TYPES = Object.freeze(['solid', 'dashed', 'dotted']);

export const DEFAULT_BASE_WIDTH = 180;
export const DEFAULT_BASE_HEIGHT = 96;
export const MIN_STROKE_DIMENSION = 1;
export const MAX_STROKE_POINTS = 8192;

const RATE_OF_PRESSURE_CHANGE = 0.275;
const CAP_SEGMENTS = 12;
const CORNER_STEPS = 13;
const FIXED_PI = Math.PI + 0.0001;

function rotateAround(px, py, cx, cy, angle) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

const SAFE_COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i;

export const DEFAULT_SAMPLE_POINTS = Object.freeze([
  Object.freeze({ x: 8, y: 64, z: 0.35 }),
  Object.freeze({ x: 28, y: 26, z: 0.58 }),
  Object.freeze({ x: 56, y: 14, z: 0.76 }),
  Object.freeze({ x: 88, y: 46, z: 0.68 }),
  Object.freeze({ x: 118, y: 80, z: 0.62 }),
  Object.freeze({ x: 148, y: 62, z: 0.52 }),
  Object.freeze({ x: 172, y: 22, z: 0.32 }),
]);

export const STROKE_DEFAULTS = Object.freeze({
  points: DEFAULT_SAMPLE_POINTS,
  segments: Object.freeze([]),
  baseWidth: DEFAULT_BASE_WIDTH,
  baseHeight: DEFAULT_BASE_HEIGHT,
  brush: 'pen',
  stroke: '#17181c',
  strokeWidth: 6,
  dash: 'solid',
  thinning: 0.55,
  streamline: 0.5,
  smoothing: 0.5,
  taperStart: 0,
  taperEnd: 0,
  fill: 'none',
  fillOpacity: 0.18,
  opacity: 1,
  isClosed: false,
  isPen: false,
});

export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function isValidHexColor(value) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value.trim());
}

export function sanitizeColor(value, fallback = '#17181c') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed === 'none' || trimmed === 'transparent') return trimmed;
  return SAFE_COLOR_PATTERN.test(trimmed) ? trimmed : fallback;
}

export function normalizeBrush(value, fallback = 'pen') {
  return typeof value === 'string' && BRUSH_TYPES.includes(value) ? value : fallback;
}

export function normalizeDash(value, fallback = 'solid') {
  return typeof value === 'string' && DASH_TYPES.includes(value) ? value : fallback;
}

/**
 * Generates preset local stroke points and dimensions for quick insertion & Copilot tools.
 */
export function createPresetStroke(preset = 'wave') {
  switch (preset) {
    case 'circle': {
      const points = [];
      const rx = 64;
      const ry = 60;
      const cx = 72;
      const cy = 68;
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        points.push({
          x: round2(cx + Math.cos(angle) * rx),
          y: round2(cy + Math.sin(angle) * ry),
          z: round3(0.45 + 0.25 * Math.sin(angle * 2)),
        });
      }
      return { points, segments: [], baseWidth: 144, baseHeight: 136, isClosed: true };
    }
    case 'box': {
      const points = [
        { x: 8, y: 8, z: 0.6 },
        { x: 172, y: 8, z: 0.65 },
        { x: 172, y: 104, z: 0.65 },
        { x: 8, y: 104, z: 0.65 },
        { x: 8, y: 8, z: 0.6 },
      ];
      return {
        points,
        segments: [{ type: 'straight', startIndex: 0, endIndex: 4 }],
        baseWidth: 180,
        baseHeight: 112,
        isClosed: true,
      };
    }
    case 'underline': {
      const points = [
        { x: 6, y: 18, z: 0.35 },
        { x: 58, y: 12, z: 0.65 },
        { x: 124, y: 15, z: 0.75 },
        { x: 188, y: 10, z: 0.68 },
        { x: 234, y: 16, z: 0.28 },
      ];
      return { points, segments: [], baseWidth: 240, baseHeight: 28, isClosed: false };
    }
    case 'highlight': {
      const points = [
        { x: 10, y: 20, z: 0.5 },
        { x: 110, y: 19, z: 0.5 },
        { x: 210, y: 20, z: 0.5 },
      ];
      return {
        points,
        segments: [{ type: 'straight', startIndex: 0, endIndex: 2 }],
        baseWidth: 220,
        baseHeight: 40,
        brush: 'highlighter',
        stroke: '#f59e0b',
        strokeWidth: 18,
        isClosed: false,
      };
    }
    case 'check': {
      const points = [
        { x: 10, y: 52, z: 0.42 },
        { x: 38, y: 82, z: 0.78 },
        { x: 68, y: 46, z: 0.66 },
        { x: 112, y: 10, z: 0.32 },
      ];
      return { points, segments: [], baseWidth: 122, baseHeight: 92, isClosed: false };
    }
    case 'arrow': {
      const points = [
        { x: 8, y: 52, z: 0.4 },
        { x: 72, y: 36, z: 0.65 },
        { x: 148, y: 36, z: 0.72 },
        { x: 122, y: 12, z: 0.55 },
        { x: 154, y: 36, z: 0.75 },
        { x: 122, y: 62, z: 0.45 },
      ];
      return { points, segments: [], baseWidth: 164, baseHeight: 74, isClosed: false };
    }
    case 'spiral': {
      const points = [];
      const cx = 72;
      const cy = 72;
      const steps = 36;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const angle = t * Math.PI * 5;
        const r = 8 + t * 56;
        points.push({
          x: round2(cx + Math.cos(angle) * r),
          y: round2(cy + Math.sin(angle) * r),
          z: round3(0.35 + 0.45 * (1 - t * 0.5)),
        });
      }
      return { points, segments: [], baseWidth: 144, baseHeight: 144, isClosed: false };
    }
    case 'wave':
    default:
      return {
        points: DEFAULT_SAMPLE_POINTS.map(p => ({ ...p })),
        segments: [],
        baseWidth: DEFAULT_BASE_WIDTH,
        baseHeight: DEFAULT_BASE_HEIGHT,
        isClosed: false,
      };
  }
}

/**
 * Sanitizes raw point lists into finite `{ x, y, z, seg }` records.
 */
export function sanitizePoints(rawPoints, segments) {
  const straightFlags = new Uint8Array(MAX_STROKE_POINTS);
  if (Array.isArray(segments)) {
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      if (!seg || seg.type !== 'straight') continue;
      const start = Math.max(0, Math.trunc(finiteOr(seg.startIndex, 0)));
      const end = Math.min(MAX_STROKE_POINTS - 1, Math.trunc(finiteOr(seg.endIndex, start)));
      // startIndex is the anchor the straight run leaves from; the anchor itself is freehand.
      for (let i = start + 1; i <= end; i++) straightFlags[i] = 1;
    }
  }

  const out = [];
  if (Array.isArray(rawPoints)) {
    const limit = Math.min(rawPoints.length, MAX_STROKE_POINTS);
    for (let i = 0; i < limit; i++) {
      const pt = rawPoints[i];
      if (!pt || typeof pt !== 'object') continue;
      const x = Number(pt.x);
      const y = Number(pt.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const z = clamp(finiteOr(Number(pt.z), 0.5), 0.01, 1);
      const seg = pt.seg === 1 || pt.segment === 'straight' || straightFlags[i] === 1 ? 1 : 0;
      out.push({ x, y, z, seg });
    }
  }

  if (out.length === 0) {
    for (let i = 0; i < DEFAULT_SAMPLE_POINTS.length; i++) {
      const p = DEFAULT_SAMPLE_POINTS[i];
      out.push({ x: p.x, y: p.y, z: p.z, seg: 0 });
    }
  }
  return out;
}

/**
 * Iterative Ramer-Douglas-Peucker (RDP) stroke decimation in (x, y) space.
 * Preserves segment mode boundaries (`seg === 1`) and endpoints without recursion.
 */
const rdpKeepMask = new Uint8Array(MAX_STROKE_POINTS);
const rdpStackLo = new Int32Array(MAX_STROKE_POINTS);
const rdpStackHi = new Int32Array(MAX_STROKE_POINTS);

export function simplifyStrokePoints(points, tolerance = 0.65) {
  if (!Array.isArray(points) || points.length <= 3 || tolerance <= 0) {
    return Array.isArray(points) ? points.slice() : [];
  }
  const n = Math.min(points.length, MAX_STROKE_POINTS);
  const tolSq = tolerance * tolerance;
  rdpKeepMask.fill(0, 0, n);
  rdpKeepMask[0] = 1;
  rdpKeepMask[n - 1] = 1;

  // Always preserve straight-segment endpoints (anchor i - 1 and target i where seg === 1)
  for (let i = 1; i < n; i++) {
    if ((points[i].seg ?? 0) === 1) {
      rdpKeepMask[i] = 1;
      rdpKeepMask[i - 1] = 1;
    }
  }

  let sp = 0;
  let anchorStart = 0;
  for (let i = 1; i < n; i++) {
    if (rdpKeepMask[i] === 1) {
      if (i - anchorStart > 1) {
        rdpStackLo[sp] = anchorStart;
        rdpStackHi[sp] = i;
        sp++;
      }
      anchorStart = i;
    }
  }

  while (sp > 0) {
    sp--;
    const lo = rdpStackLo[sp];
    const hi = rdpStackHi[sp];
    if (hi - lo <= 1) continue;

    const ax = points[lo].x;
    const ay = points[lo].y;
    const bx = points[hi].x;
    const by = points[hi].y;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let maxDistSq = -1;
    let splitIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const px = points[i].x;
      const py = points[i].y;
      let distSq;
      if (lenSq <= 1e-9) {
        const ex = px - ax;
        const ey = py - ay;
        distSq = ex * ex + ey * ey;
      } else {
        const t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
        const projX = ax + dx * t;
        const projY = ay + dy * t;
        const ex = px - projX;
        const ey = py - projY;
        distSq = ex * ex + ey * ey;
      }
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        splitIdx = i;
      }
    }

    if (maxDistSq > tolSq && splitIdx > lo && splitIdx < hi) {
      rdpKeepMask[splitIdx] = 1;
      if (splitIdx - lo > 1) {
        rdpStackLo[sp] = lo;
        rdpStackHi[sp] = splitIdx;
        sp++;
      }
      if (hi - splitIdx > 1) {
        rdpStackLo[sp] = splitIdx;
        rdpStackHi[sp] = hi;
        sp++;
      }
    }
  }

  const simplified = [];
  for (let i = 0; i < n; i++) {
    if (rdpKeepMask[i] === 1) {
      simplified.push(points[i]);
    }
  }
  return simplified;
}

/**
 * Rebounds world or arbitrary stroke points into normalized local `[0..baseWidth, 0..baseHeight]`
 * coordinates and extracts contiguous straight-line segment ranges.
 */
export function normalizeStrokeGeometry(rawPoints, options = {}) {
  const tol = finiteOr(options.simplifyTolerance, 0);
  const working = tol > 0 ? simplifyStrokePoints(rawPoints, tol) : rawPoints;
  if (!Array.isArray(working) || working.length === 0) {
    return {
      x: 0,
      y: 0,
      width: DEFAULT_BASE_WIDTH,
      height: DEFAULT_BASE_HEIGHT,
      baseWidth: DEFAULT_BASE_WIDTH,
      baseHeight: DEFAULT_BASE_HEIGHT,
      points: DEFAULT_SAMPLE_POINTS.map(p => ({ ...p })),
      segments: [],
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < working.length; i++) {
    const p = working[i];
    const x = finiteOr(p?.x, 0);
    const y = finiteOr(p?.y, 0);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    minX = 0;
    minY = 0;
    maxX = DEFAULT_BASE_WIDTH;
    maxY = DEFAULT_BASE_HEIGHT;
  }

  const rawW = maxX - minX;
  const rawH = maxY - minY;
  const padX = rawW < MIN_STROKE_DIMENSION ? (MIN_STROKE_DIMENSION - rawW) * 0.5 : 0;
  const padY = rawH < MIN_STROKE_DIMENSION ? (MIN_STROKE_DIMENSION - rawH) * 0.5 : 0;
  const originX = minX - padX;
  const originY = minY - padY;
  const baseWidth = Math.max(MIN_STROKE_DIMENSION, round2(rawW + padX * 2));
  const baseHeight = Math.max(MIN_STROKE_DIMENSION, round2(rawH + padY * 2));

  const points = new Array(working.length);
  const segments = [];
  let segStart = -1;

  for (let i = 0; i < working.length; i++) {
    const p = working[i];
    const z = round3(clamp(finiteOr(p?.z, 0.5), 0.01, 1));
    points[i] = {
      x: round2(finiteOr(p?.x, originX) - originX),
      y: round2(finiteOr(p?.y, originY) - originY),
      z,
    };
    const isStraight = p?.seg === 1 || p?.segment === 'straight';
    if (isStraight) {
      if (segStart < 0) segStart = Math.max(0, i - 1);
    } else if (segStart >= 0) {
      segments.push({ type: 'straight', startIndex: segStart, endIndex: i - 1 });
      segStart = -1;
    }
  }
  if (segStart >= 0) {
    segments.push({ type: 'straight', startIndex: segStart, endIndex: working.length - 1 });
  }

  return {
    x: round2(originX),
    y: round2(originY),
    width: baseWidth,
    height: baseHeight,
    baseWidth,
    baseHeight,
    points,
    segments,
  };
}

/**
 * Step 1 of tldraw / perfect-freehand pipeline:
 * Converts raw input points into streamlined stroke points with running length and unit direction vectors.
 */
export function getStrokePoints(rawPoints, options = {}) {
  const streamline = clamp(finiteOr(options.streamline, 0.5), 0, 0.95);
  const size = Math.max(1, finiteOr(options.size, 6));
  const isClosed = Boolean(options.isClosed);
  const t = 0.15 + (1 - streamline) * 0.85;

  const n = rawPoints.length;
  if (n === 0) return [];

  // Normalize input list & expand straight segments slightly for smooth pressure transitions
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = rawPoints[i];
    if (i > 0 && p.seg === 1) {
      const prev = pts[pts.length - 1];
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.min(8, Math.max(1, Math.floor(dist / Math.max(4, size * 1.5))));
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        pts.push({
          x: prev.x + dx * u,
          y: prev.y + dy * u,
          z: prev.z + (p.z - prev.z) * u,
          seg: 1,
        });
      }
    } else {
      pts.push({ x: p.x, y: p.y, z: p.z ?? 0.5, seg: p.seg ?? 0 });
    }
  }

  if (isClosed && pts.length >= 3) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > 0.5) {
      pts.push({ x: first.x, y: first.y, z: first.z, seg: last.seg });
    }
  }

  if (pts.length === 1) {
    pts.push({ x: pts[0].x + 0.01, y: pts[0].y + 0.01, z: pts[0].z, seg: 0 });
  }

  const strokePoints = [
    {
      x: pts[0].x,
      y: pts[0].y,
      pressure: clamp(pts[0].z, 0.01, 1),
      vx: 1,
      vy: 0,
      distance: 0,
      runningLength: 0,
      seg: pts[0].seg,
    },
  ];

  let totalLength = 0;
  let prev = strokePoints[0];

  for (let i = 1, len = pts.length; i < len; i++) {
    const curr = pts[i];
    const isLast = i === len - 1;
    const useExact = isLast || curr.seg === 1;
    const ix = useExact ? curr.x : prev.x + (curr.x - prev.x) * t;
    const iy = useExact ? curr.y : prev.y + (curr.y - prev.y) * t;

    const dx = prev.x - ix;
    const dy = prev.y - iy;
    const distance = Math.hypot(dx, dy);

    if (!isLast && distance < 0.05) continue;

    totalLength += distance;
    const invDist = distance > 1e-6 ? 1 / distance : 0;
    const nextPt = {
      x: ix,
      y: iy,
      pressure: clamp(curr.z, 0.01, 1),
      vx: distance > 1e-6 ? dx * invDist : prev.vx,
      vy: distance > 1e-6 ? dy * invDist : prev.vy,
      distance,
      runningLength: totalLength,
      seg: curr.seg,
    };
    strokePoints.push(nextPt);
    prev = nextPt;
  }

  if (strokePoints.length > 1) {
    strokePoints[0].vx = strokePoints[1].vx;
    strokePoints[0].vy = strokePoints[1].vy;
  }

  return strokePoints;
}

export function getStrokeRadius(size, thinning, pressure) {
  if (thinning === 0) return size * 0.5;
  // Smooth sine-ease pressure curve matching tldraw / perfect-freehand feel
  const eased = 0.5 - Math.cos(pressure * Math.PI) * 0.5;
  return size * clamp(0.5 - thinning * (0.5 - eased), 0.08, 1);
}

/**
 * Step 2 of tldraw / perfect-freehand pipeline:
 * Generates the variable-width left/right offset polygon with caps and tapers.
 */
export function getStrokeOutlinePoints(strokePoints, options = {}) {
  const n = strokePoints.length;
  if (n === 0) return [];

  const size = Math.max(1, finiteOr(options.size, 6));
  const thinning = clamp(finiteOr(options.thinning, 0.55), 0, 0.95);
  const smoothing = clamp(finiteOr(options.smoothing, 0.5), 0, 1);
  const simulatePressure = options.simulatePressure !== false;
  const taperStart = Math.max(0, finiteOr(options.taperStart, 0));
  const taperEnd = Math.max(0, finiteOr(options.taperEnd, 0));
  const isClosed = Boolean(options.isClosed);

  const totalLength = strokePoints[n - 1].runningLength;
  if (n === 1 || totalLength <= Math.max(1.2, size * 0.2)) {
    // Dot outline polygon
    const center = strokePoints[0];
    const r = getStrokeRadius(size, thinning * 0.5, center.pressure);
    const circle = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      circle.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
    }
    return circle;
  }

  const minDistSq = Math.pow(size * smoothing * 0.3, 2);
  const leftPts = [];
  const rightPts = [];

  let prevPressure = strokePoints[0].pressure;
  for (let i = 0; i < Math.min(3, n); i++) {
    const pt = strokePoints[i];
    if (simulatePressure) {
      const sp = Math.min(1, pt.distance / size);
      const rp = Math.min(1, 1 - sp);
      prevPressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
    } else {
      prevPressure = prevPressure + (pt.pressure - prevPressure) * 0.5;
    }
  }

  // perfect-freehand corner model. Direction vectors point from a point back to its
  // predecessor; offsets are taken perpendicular to a blend of this and the next direction.
  let prevVx = strokePoints[0].vx;
  let prevVy = strokePoints[0].vy;
  let prevLx = strokePoints[0].x;
  let prevLy = strokePoints[0].y;
  let prevRx = strokePoints[0].x;
  let prevRy = strokePoints[0].y;
  let firstRadius = -1;
  let lastRadius = size * 0.5;
  let isPrevPointSharpCorner = false;

  for (let i = 0; i < n; i++) {
    const pt = strokePoints[i];
    const isLast = i === n - 1;
    // Points in the last few units add only end jitter (perfect-freehand drops them too).
    if (!isLast && totalLength - pt.runningLength < 3) continue;

    let pressure = pt.pressure;
    if (thinning > 0) {
      if (simulatePressure) {
        const sp = Math.min(1, pt.distance / size);
        const rp = Math.min(1, 1 - sp);
        pressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
      } else {
        pressure = prevPressure + (pressure - prevPressure) * 0.5;
      }
    }

    let radius = getStrokeRadius(size, thinning, pressure);
    if (taperStart > 0 && pt.runningLength < taperStart) {
      const u = pt.runningLength / taperStart;
      radius *= u * (2 - u);
    }
    if (taperEnd > 0 && totalLength - pt.runningLength < taperEnd) {
      const u = (totalLength - pt.runningLength) / taperEnd;
      radius *= u * (2 - u);
    }
    radius = Math.max(0.25, radius);
    if (firstRadius < 0) firstRadius = radius;
    lastRadius = radius;

    const vx = pt.vx;
    const vy = pt.vy;
    const next = isLast ? pt : strokePoints[i + 1];
    const nextDpr = isLast ? 1 : vx * next.vx + vy * next.vy;
    const prevDpr = vx * prevVx + vy * prevVy;
    const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
    const isNextPointSharpCorner = nextDpr < 0;

    // Written in perfect-freehand's convention (per(v) = (vy, -vx), its left = point - offset).
    // Our cap code expects the mirrored sides, so pf-left goes to rightPts and pf-right to leftPts.
    if (isPointSharpCorner || isNextPointSharpCorner) {
      // Sharp turn: sweep a half circle around the corner so the outline wraps the turn
      // instead of crossing itself.
      const ox = prevVy * radius;
      const oy = -prevVx * radius;
      let tl = null;
      let tr = null;
      for (let step = 0; step <= CORNER_STEPS; step++) {
        const a = FIXED_PI * (step / CORNER_STEPS);
        tl = rotateAround(pt.x - ox, pt.y - oy, pt.x, pt.y, a);
        tr = rotateAround(pt.x + ox, pt.y + oy, pt.x, pt.y, -a);
        rightPts.push(tl);
        leftPts.push(tr);
      }
      prevRx = tl.x;
      prevRy = tl.y;
      prevLx = tr.x;
      prevLy = tr.y;
      if (isNextPointSharpCorner) isPrevPointSharpCorner = true;
      continue;
    }
    isPrevPointSharpCorner = false;

    if (isLast) {
      const ox = vy * radius;
      const oy = -vx * radius;
      rightPts.push({ x: pt.x - ox, y: pt.y - oy });
      leftPts.push({ x: pt.x + ox, y: pt.y + oy });
      continue;
    }

    // Blend toward the next direction so gentle turns get a mitred, gap-free offset.
    const bx = next.vx + (vx - next.vx) * nextDpr;
    const by = next.vy + (vy - next.vy) * nextDpr;
    const ox = by * radius;
    const oy = -bx * radius;
    const rx = pt.x - ox;
    const ry = pt.y - oy;
    const lx = pt.x + ox;
    const ly = pt.y + oy;

    if (i <= 1 || (lx - prevLx) * (lx - prevLx) + (ly - prevLy) * (ly - prevLy) > minDistSq) {
      leftPts.push({ x: lx, y: ly });
      prevLx = lx;
      prevLy = ly;
    }
    if (i <= 1 || (rx - prevRx) * (rx - prevRx) + (ry - prevRy) * (ry - prevRy) > minDistSq) {
      rightPts.push({ x: rx, y: ry });
      prevRx = rx;
      prevRy = ry;
    }

    prevPressure = pressure;
    prevVx = vx;
    prevVy = vy;
  }
  if (firstRadius < 0) firstRadius = lastRadius;

  const startPt = strokePoints[0];
  const endPt = strokePoints[n - 1];
  const firstL = leftPts[0] ?? startPt;
  const firstR = rightPts[0] ?? startPt;
  const lastL = leftPts[leftPts.length - 1] ?? endPt;
  const lastR = rightPts[rightPts.length - 1] ?? endPt;

  const endCap = [];
  if (!isClosed) {
    if (taperEnd > 0) {
      endCap.push({ x: endPt.x, y: endPt.y });
    } else {
      const dx = lastL.x - lastR.x;
      const dy = lastL.y - lastR.y;
      const startAngle = Math.atan2(dy, dx);
      // Sweep around the front of the stroke end (in the direction of travel).
      const front = Math.cos(startAngle + Math.PI * 0.5) * endPt.vx + Math.sin(startAngle + Math.PI * 0.5) * endPt.vy < 0 ? 1 : -1;
      for (let i = 1; i < CAP_SEGMENTS; i++) {
        const a = startAngle + front * (i / CAP_SEGMENTS) * Math.PI;
        endCap.push({
          x: endPt.x + Math.cos(a) * lastRadius,
          y: endPt.y + Math.sin(a) * lastRadius,
        });
      }
    }
  }

  const startCap = [];
  if (!isClosed) {
    if (taperStart > 0) {
      startCap.push({ x: startPt.x, y: startPt.y });
    } else {
      const dx = firstR.x - firstL.x;
      const dy = firstR.y - firstL.y;
      const startAngle = Math.atan2(dy, dx);
      // Sweep around the back of the stroke start (away from the direction of travel).
      const back = Math.cos(startAngle + Math.PI * 0.5) * startPt.vx + Math.sin(startAngle + Math.PI * 0.5) * startPt.vy > 0 ? 1 : -1;
      for (let i = 1; i < CAP_SEGMENTS; i++) {
        const a = startAngle + back * (i / CAP_SEGMENTS) * Math.PI;
        startCap.push({
          x: startPt.x + Math.cos(a) * firstRadius,
          y: startPt.y + Math.sin(a) * firstRadius,
        });
      }
    }
  }

  const outline = [];
  for (let i = 0; i < leftPts.length; i++) outline.push(leftPts[i]);
  for (let i = 0; i < endCap.length; i++) outline.push(endCap[i]);
  for (let i = rightPts.length - 1; i >= 0; i--) outline.push(rightPts[i]);
  for (let i = 0; i < startCap.length; i++) outline.push(startCap[i]);

  return outline;
}

/**
 * Step 3 of tldraw pipeline:
 * Compiles a point ring or polyline into a smooth quadratic Bezier midpoint SVG path (`M ... Q ... Z`).
 */
export function getSvgPathFromStrokePoints(points, closed = true) {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) {
    const p = points[0];
    return `M ${round2(p.x)} ${round2(p.y)}`;
  }
  if (n === 2) {
    const a = points[0];
    const b = points[1];
    return `M ${round2(a.x)} ${round2(a.y)} L ${round2(b.x)} ${round2(b.y)}${closed ? ' Z' : ''}`;
  }

  const p0 = points[0];
  const p1 = points[1];
  let d = `M ${round2(p0.x)} ${round2(p0.y)} Q ${round2(p1.x)} ${round2(p1.y)} ${round2((p1.x + points[2].x) * 0.5)} ${round2((p1.y + points[2].y) * 0.5)}`;

  for (let i = 2; i < n - 1; i++) {
    const curr = points[i];
    const next = points[i + 1];
    const mx = round2((curr.x + next.x) * 0.5);
    const my = round2((curr.y + next.y) * 0.5);
    d += ` T ${mx} ${my}`;
  }

  if (closed) {
    const last = points[n - 1];
    const first = points[0];
    d += ` Q ${round2(last.x)} ${round2(last.y)} ${round2((last.x + first.x) * 0.5)} ${round2((last.y + first.y) * 0.5)} Z`;
  } else {
    const last = points[n - 1];
    d += ` L ${round2(last.x)} ${round2(last.y)}`;
  }

  return d;
}

export function createDotSvgPath(cx, cy, radius) {
  const r = Math.max(0.5, round2(radius));
  const x0 = round2(cx - r);
  const y0 = round2(cy);
  const d2 = round2(r * 2);
  return `M ${x0} ${y0} a ${r} ${r} 0 1 0 ${d2} 0 a ${r} ${r} 0 1 0 ${-d2} 0 Z`;
}

/**
 * Resolves effective brush parameters for a stroke aspect record.
 */
export function resolveStrokeStyle(props = STROKE_DEFAULTS) {
  const brush = normalizeBrush(props?.brush, STROKE_DEFAULTS.brush);
  const dash = normalizeDash(props?.dash, STROKE_DEFAULTS.dash);
  const rawWidth = clamp(finiteOr(Number(props?.strokeWidth), STROKE_DEFAULTS.strokeWidth), 1, 64);
  const stroke = sanitizeColor(props?.stroke, STROKE_DEFAULTS.stroke);
  const fill = sanitizeColor(props?.fill, STROKE_DEFAULTS.fill);
  const fillOpacity = clamp(finiteOr(Number(props?.fillOpacity), STROKE_DEFAULTS.fillOpacity), 0, 1);
  const rawOpacity = clamp(finiteOr(Number(props?.opacity), STROKE_DEFAULTS.opacity), 0.05, 1);
  const streamline = clamp(finiteOr(Number(props?.streamline), STROKE_DEFAULTS.streamline), 0, 0.95);
  const smoothing = clamp(finiteOr(Number(props?.smoothing), STROKE_DEFAULTS.smoothing), 0, 1);
  const taperStart = clamp(finiteOr(Number(props?.taperStart), STROKE_DEFAULTS.taperStart), 0, 120);
  const taperEnd = clamp(finiteOr(Number(props?.taperEnd), STROKE_DEFAULTS.taperEnd), 0, 120);
  const isClosed = Boolean(props?.isClosed);
  const isPen = Boolean(props?.isPen);

  let effectiveWidth = rawWidth;
  let effectiveThinning = clamp(finiteOr(Number(props?.thinning), STROKE_DEFAULTS.thinning), 0, 0.95);
  let effectiveOpacity = rawOpacity;

  if (brush === 'fine') {
    effectiveThinning = 0;
  } else if (brush === 'marker') {
    effectiveWidth = round2(rawWidth * 1.25);
    effectiveThinning = Math.max(0.68, effectiveThinning);
  } else if (brush === 'highlighter') {
    effectiveWidth = round2(rawWidth * 2.1);
    effectiveThinning = 0;
    effectiveOpacity = round3(Math.min(rawOpacity, 0.42));
  }

  const useOutlinePolygon = dash === 'solid' && effectiveThinning > 0 && (brush === 'pen' || brush === 'marker');
  const dashArray =
    dash === 'dashed'
      ? `${round2(effectiveWidth * 2)} ${round2(effectiveWidth * 1.5)}`
      : dash === 'dotted'
        ? `0.1 ${round2(effectiveWidth * 1.8)}`
        : '';

  return Object.freeze({
    brush,
    dash,
    dashArray,
    stroke,
    strokeWidth: rawWidth,
    effectiveWidth,
    thinning: effectiveThinning,
    streamline,
    smoothing,
    taperStart,
    taperEnd,
    fill,
    fillOpacity,
    opacity: rawOpacity,
    effectiveOpacity,
    isClosed,
    isPen,
    useOutlinePolygon,
  });
}

/**
 * Compiles local scaled geometry for a stroke.
 */
function compileLocalStroke(props, width, height) {
  const style = resolveStrokeStyle(props);
  const baseWidth = Math.max(MIN_STROKE_DIMENSION, finiteOr(Number(props?.baseWidth), width));
  const baseHeight = Math.max(MIN_STROKE_DIMENSION, finiteOr(Number(props?.baseHeight), height));
  const scaleX = width / baseWidth;
  const scaleY = height / baseHeight;

  const rawPts = sanitizePoints(props?.points, props?.segments);
  const scaledPts = new Array(rawPts.length);
  for (let i = 0; i < rawPts.length; i++) {
    const p = rawPts[i];
    scaledPts[i] = {
      x: p.x * scaleX,
      y: p.y * scaleY,
      z: p.z,
      seg: p.seg,
    };
  }

  const strokePoints = getStrokePoints(scaledPts, {
    size: style.effectiveWidth,
    streamline: style.streamline,
    isClosed: style.isClosed,
  });

  const totalLength = strokePoints.length > 0 ? strokePoints[strokePoints.length - 1].runningLength : 0;
  const isDot = strokePoints.length <= 1 || totalLength <= Math.max(1.2, style.effectiveWidth * 0.2);

  let renderMode = 'centerline-stroke';
  let outlinePoints = [];
  let outlinePathD = '';
  let centerlinePathD = '';
  let fillPathD = '';

  if (isDot) {
    renderMode = 'dot';
    const center = strokePoints[0] ?? { x: width * 0.5, y: height * 0.5, pressure: 0.5 };
    const dotRadius = getStrokeRadius(
      style.effectiveWidth,
      style.thinning * 0.5,
      style.isPen ? center.pressure : 0.65,
    );
    outlinePathD = createDotSvgPath(center.x, center.y, dotRadius);
    centerlinePathD = outlinePathD;
    outlinePoints = getStrokeOutlinePoints([center], {
      size: style.effectiveWidth,
      thinning: style.thinning,
      simulatePressure: !style.isPen,
    });
  } else {
    centerlinePathD = getSvgPathFromStrokePoints(strokePoints, style.isClosed);
    if ((style.fill !== 'none' && style.fill !== 'transparent' && style.fillOpacity > 0) || style.isClosed) {
      fillPathD = style.isClosed ? centerlinePathD : getSvgPathFromStrokePoints(strokePoints, true);
    }
    if (style.useOutlinePolygon) {
      renderMode = 'freehand-outline';
      outlinePoints = getStrokeOutlinePoints(strokePoints, {
        size: style.effectiveWidth,
        thinning: style.thinning,
        smoothing: style.smoothing,
        simulatePressure: !style.isPen,
        taperStart: style.taperStart,
        taperEnd: style.taperEnd,
        isClosed: style.isClosed,
      });
      outlinePathD = getSvgPathFromStrokePoints(outlinePoints, true);
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < strokePoints.length; i++) {
    const p = strokePoints[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = width;
    maxY = height;
  }

  const pad = style.effectiveWidth * 0.65 + 2;
  const localInkBounds = Object.freeze({
    x: round2(minX - pad),
    y: round2(minY - pad),
    width: round2(Math.max(1, maxX - minX + pad * 2)),
    height: round2(Math.max(1, maxY - minY + pad * 2)),
  });

  return Object.freeze({
    style,
    baseWidth,
    baseHeight,
    isDot,
    renderMode,
    totalLength: round2(totalLength),
    localPoints: Object.freeze(strokePoints.map(p => Object.freeze({ x: round2(p.x), y: round2(p.y), pressure: round3(p.pressure) }))),
    localOutlinePoints: Object.freeze(outlinePoints.map(p => Object.freeze({ x: round2(p.x), y: round2(p.y) }))),
    outlinePathD,
    centerlinePathD,
    fillPathD,
    pathD: renderMode === 'freehand-outline' || renderMode === 'dot' ? outlinePathD : centerlinePathD,
    localInkBounds,
  });
}

// Pure memoization keyed by frozen canonical props object so transform-only updates are O(1)
const localGeometryCache = new WeakMap();

function getCachedLocalStroke(props, width, height) {
  if (props && typeof props === 'object' && Object.isFrozen(props)) {
    const cached = localGeometryCache.get(props);
    if (cached && cached.width === width && cached.height === height) {
      return cached.compiled;
    }
    const compiled = compileLocalStroke(props, width, height);
    localGeometryCache.set(props, { width, height, compiled });
    return compiled;
  }
  return compileLocalStroke(props, width, height);
}

/**
 * Pure `derive(props, entityId, view)` implementation for `drawing.freehand.stroke`.
 */
export function deriveStrokeGeometry(props, entityId, view) {
  const transform = view?.getCanonical?.(entityId, 'core.transform');
  const bounds = view?.getCanonical?.(entityId, 'core.bounds');

  const baseWidth = Math.max(MIN_STROKE_DIMENSION, finiteOr(Number(props?.baseWidth), DEFAULT_BASE_WIDTH));
  const baseHeight = Math.max(MIN_STROKE_DIMENSION, finiteOr(Number(props?.baseHeight), DEFAULT_BASE_HEIGHT));

  const x = finiteOr(transform?.x, 0);
  const y = finiteOr(transform?.y, 0);
  const rotation = finiteOr(transform?.rotation, 0);
  const width =
    typeof bounds?.width === 'number' && Number.isFinite(bounds.width) && bounds.width > 0
      ? bounds.width
      : baseWidth;
  const height =
    typeof bounds?.height === 'number' && Number.isFinite(bounds.height) && bounds.height > 0
      ? bounds.height
      : baseHeight;

  const local = getCachedLocalStroke(props ?? STROKE_DEFAULTS, width, height);

  const cx = x + width * 0.5;
  const cy = y + height * 0.5;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const toWorld = (lx, ly) => {
    if (rotation === 0) {
      return Object.freeze({ x: round2(x + lx), y: round2(y + ly) });
    }
    const dx = x + lx - cx;
    const dy = y + ly - cy;
    return Object.freeze({
      x: round2(cx + dx * cos - dy * sin),
      y: round2(cy + dx * sin + dy * cos),
    });
  };

  const sampledPoints = new Array(local.localPoints.length);
  for (let i = 0; i < local.localPoints.length; i++) {
    const p = local.localPoints[i];
    sampledPoints[i] = toWorld(p.x, p.y);
  }

  // Transform the 4 corners of localInkBounds into world AABB for spatial culling (`paintBounds`)
  const lb = local.localInkBounds;
  const c0 = toWorld(lb.x, lb.y);
  const c1 = toWorld(lb.x + lb.width, lb.y);
  const c2 = toWorld(lb.x + lb.width, lb.y + lb.height);
  const c3 = toWorld(lb.x, lb.y + lb.height);

  const minWX = Math.min(c0.x, c1.x, c2.x, c3.x);
  const minWY = Math.min(c0.y, c1.y, c2.y, c3.y);
  const maxWX = Math.max(c0.x, c1.x, c2.x, c3.x);
  const maxWY = Math.max(c0.y, c1.y, c2.y, c3.y);

  const inkBounds = Object.freeze({
    x: round2(minWX),
    y: round2(minWY),
    width: round2(Math.max(1, maxWX - minWX)),
    height: round2(Math.max(1, maxWY - minWY)),
  });

  return Object.freeze({
    aspectId: STROKE_ASPECT_ID,
    x,
    y,
    width,
    height,
    rotation,
    baseWidth: local.baseWidth,
    baseHeight: local.baseHeight,
    style: local.style,
    isDot: local.isDot,
    renderMode: local.renderMode,
    totalLength: local.totalLength,
    pathD: local.pathD,
    outlinePathD: local.outlinePathD,
    centerlinePathD: local.centerlinePathD,
    fillPathD: local.fillPathD,
    localPoints: local.localPoints,
    localOutlinePoints: local.localOutlinePoints,
    sampledPoints: Object.freeze(sampledPoints),
    localInkBounds: local.localInkBounds,
    inkBounds,
  });
}
