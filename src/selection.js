import { STROKE_ASPECT_ID } from './manifest.js';

const COMPUTED_STROKE_ID = `computed.${STROKE_ASPECT_ID}`;

function readGeometry(id, view) {
  if (!view || typeof view.isAlive !== 'function' || !view.isAlive(id)) return undefined;
  if (!view.getCanonical?.(id, STROKE_ASPECT_ID)) return undefined;
  return view.getComputed?.(id, COMPUTED_STROKE_ID);
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function pointInPolygon(px, py, points) {
  if (!points || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function segmentIntersectsBox(ax, ay, bx, by, minX, minY, maxX, maxY) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;

  if (dx === 0) {
    if (ax < minX || ax > maxX) return false;
  } else {
    const inv = 1 / dx;
    let tNear = (minX - ax) * inv;
    let tFar = (maxX - ax) * inv;
    if (tNear > tFar) {
      const tmp = tNear;
      tNear = tFar;
      tFar = tmp;
    }
    if (tNear > t0) t0 = tNear;
    if (tFar < t1) t1 = tFar;
    if (t0 > t1) return false;
  }

  if (dy === 0) {
    if (ay < minY || ay > maxY) return false;
  } else {
    const inv = 1 / dy;
    let tNear = (minY - ay) * inv;
    let tFar = (maxY - ay) * inv;
    if (tNear > tFar) {
      const tmp = tNear;
      tNear = tFar;
      tFar = tmp;
    }
    if (tNear > t0) t0 = tNear;
    if (tFar < t1) t1 = tFar;
    if (t0 > t1) return false;
  }

  return t0 <= t1;
}

/**
 * Analytical selection & hit-testing contribution (`EntitySelectionContribution`) for freehand strokes.
 * Uses 0-GC screen projection and fast AABB early rejection.
 */
export function createStrokeSelectionContribution() {
  return {
    priority: 20,

    getBounds(id, view, out) {
      const geometry = readGeometry(id, view);
      if (!geometry || !geometry.sampledPoints?.length) return false;
      if (geometry.isDot) {
        // tldraw treats a dot as a circle of the stroke width, so its box is never a 1px sliver.
        const size = Math.max(geometry.style.effectiveWidth, 1);
        const p = geometry.sampledPoints[0];
        out.x = p.x - size * 0.5;
        out.y = p.y - size * 0.5;
        out.width = size;
        out.height = size;
        out.rotation = 0;
        return true;
      }
      out.x = geometry.x;
      out.y = geometry.y;
      out.width = geometry.width;
      out.height = geometry.height;
      out.rotation = geometry.rotation;
      return true;
    },

    hitTest(id, view, x, y, zoom) {
      const geometry = readGeometry(id, view);
      if (!geometry || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) {
        return Infinity;
      }

      const tolerance = 8 / zoom;
      const ib = geometry.inkBounds;
      if (
        ib
        && (x < ib.x - tolerance
          || x > ib.x + ib.width + tolerance
          || y < ib.y - tolerance
          || y > ib.y + ib.height + tolerance)
      ) {
        return Infinity;
      }

      const { style, sampledPoints } = geometry;
      const n = sampledPoints.length;
      if (n === 0) return Infinity;

      const hasFill = style.fill !== 'none' && style.fill !== 'transparent' && style.fillOpacity > 0;
      if (hasFill && pointInPolygon(x, y, sampledPoints)) {
        return 0;
      }

      const halfWidth = style.effectiveWidth * 0.5;
      if (n === 1) {
        const d = Math.max(0, Math.hypot(x - sampledPoints[0].x, y - sampledPoints[0].y) - halfWidth);
        return d <= tolerance ? d : Infinity;
      }

      let minDist = Infinity;
      for (let i = 1; i < n; i++) {
        const a = sampledPoints[i - 1];
        const b = sampledPoints[i];
        const d = Math.max(0, pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y) - halfWidth);
        if (d === 0) return 0;
        if (d < minDist) minDist = d;
      }

      if (style.isClosed && n > 2) {
        const a = sampledPoints[n - 1];
        const b = sampledPoints[0];
        const d = Math.max(0, pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y) - halfWidth);
        if (d < minDist) minDist = d;
      }

      return minDist <= tolerance ? minDist : Infinity;
    },

    intersectsRect(id, view, minX, minY, maxX, maxY) {
      const geometry = readGeometry(id, view);
      if (
        !geometry
        || !Number.isFinite(minX)
        || !Number.isFinite(minY)
        || !Number.isFinite(maxX)
        || !Number.isFinite(maxY)
        || minX > maxX
        || minY > maxY
      ) {
        return false;
      }

      const ib = geometry.inkBounds;
      if (ib && (ib.x + ib.width < minX || ib.x > maxX || ib.y + ib.height < minY || ib.y > maxY)) {
        return false;
      }

      const { style, sampledPoints } = geometry;
      const n = sampledPoints.length;
      if (n === 0) return false;

      const half = style.effectiveWidth * 0.5;
      const exMinX = minX - half;
      const exMinY = minY - half;
      const exMaxX = maxX + half;
      const exMaxY = maxY + half;

      if (n === 1) {
        const p = sampledPoints[0];
        return p.x >= exMinX && p.x <= exMaxX && p.y >= exMinY && p.y <= exMaxY;
      }

      for (let i = 1; i < n; i++) {
        const a = sampledPoints[i - 1];
        const b = sampledPoints[i];
        if (segmentIntersectsBox(a.x, a.y, b.x, b.y, exMinX, exMinY, exMaxX, exMaxY)) {
          return true;
        }
      }

      if (style.isClosed && n > 2) {
        const a = sampledPoints[n - 1];
        const b = sampledPoints[0];
        if (segmentIntersectsBox(a.x, a.y, b.x, b.y, exMinX, exMinY, exMaxX, exMaxY)) {
          return true;
        }
      }

      const hasFill = style.fill !== 'none' && style.fill !== 'transparent' && style.fillOpacity > 0;
      if (hasFill && pointInPolygon((minX + maxX) * 0.5, (minY + maxY) * 0.5, sampledPoints)) {
        return true;
      }

      return false;
    },

    // tldraw parity: a draw shape is selected and hovered as its rotated bounding box,
    // not as a stroke-shaped outline. Omitting getOutlinePath makes SelectSuite draw the
    // box from getBounds(), and the handles below resize/rotate it like any other shape.
    canTransform(id, view) {
      return Boolean(readGeometry(id, view));
    },
    canResize(id, view) {
      return Boolean(readGeometry(id, view));
    },
    canRotate(id, view) {
      return Boolean(readGeometry(id, view));
    },
  };
}

function parseHexToRgba(hex) {
  if (typeof hex !== 'string' || !/^#[\da-f]{6}$/i.test(hex)) return null;
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1];
}

/**
 * Optional GPU polyline contribution for uniform-width opaque solid strokes.
 */
export function createStrokeGpuContribution() {
  return {
    aspectId: STROKE_ASPECT_ID,
    getPolyline(entityId, view) {
      const geometry = readGeometry(entityId, view);
      if (!geometry || geometry.isDot) return undefined;
      const { style, sampledPoints } = geometry;
      // Only constant-width, solid, opaque, unclosed strokes use GPU polyline;
      // variable-width pen outlines and translucent highlighters use the exact SVG path renderer.
      if (
        style.useOutlinePolygon
        || style.thinning > 0
        || style.dash !== 'solid'
        || style.effectiveOpacity !== 1
        || style.isClosed
        || (style.fill !== 'none' && style.fill !== 'transparent' && style.fillOpacity > 0)
        || sampledPoints.length < 2
      ) {
        return undefined;
      }
      const color = parseHexToRgba(style.stroke);
      if (!color) return undefined;
      // Alid's GpuPolylineGeometry reads strokeWidth/strokeCap/strokeJoin; match the SVG
      // preview's round caps and joins so the committed line looks like the one drawn.
      return {
        points: sampledPoints,
        strokeWidth: style.effectiveWidth,
        strokeCap: 'round',
        strokeJoin: 'round',
        color,
      };
    },
  };
}
