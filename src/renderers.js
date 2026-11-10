import {
  DEFAULT_BASE_HEIGHT,
  DEFAULT_BASE_WIDTH,
  STROKE_DEFAULTS,
  deriveStrokeGeometry,
  finiteOr,
  round2,
} from './freehand.js';

export function escapeAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function ensureDerived(props, derived, entityId) {
  if (derived && typeof derived.pathD === 'string' && derived.style) {
    return derived;
  }
  const syntheticTransform = {
    x: finiteOr(derived?.x, 0),
    y: finiteOr(derived?.y, 0),
    rotation: finiteOr(derived?.rotation, 0),
  };
  const syntheticBounds = {
    width: Math.max(1, finiteOr(derived?.width, finiteOr(props?.baseWidth, DEFAULT_BASE_WIDTH))),
    height: Math.max(1, finiteOr(derived?.height, finiteOr(props?.baseHeight, DEFAULT_BASE_HEIGHT))),
  };
  return deriveStrokeGeometry(props ?? STROKE_DEFAULTS, entityId, {
    getCanonical(_id, aspectId) {
      if (aspectId === 'core.transform') return syntheticTransform;
      if (aspectId === 'core.bounds') return syntheticBounds;
      return undefined;
    },
  });
}

/**
 * Builds the inner SVG paths for a compiled stroke in local `[0..width, 0..height]` coordinates.
 */
export function buildInnerStrokeSvgMarkup(compiled) {
  const { style, renderMode, outlinePathD, centerlinePathD, fillPathD } = compiled;
  const parts = [];

  if (fillPathD && style.fill !== 'none' && style.fill !== 'transparent' && style.fillOpacity > 0) {
    parts.push(
      `<path d="${escapeAttr(fillPathD)}" fill="${escapeAttr(style.fill)}" fill-opacity="${round2(style.fillOpacity * style.effectiveOpacity)}" stroke="none" />`,
    );
  }

  if (style.stroke !== 'none' && style.stroke !== 'transparent' && style.effectiveWidth > 0) {
    if (renderMode === 'freehand-outline' || renderMode === 'dot') {
      parts.push(
        `<path d="${escapeAttr(outlinePathD)}" fill="${escapeAttr(style.stroke)}" fill-opacity="${style.effectiveOpacity}" stroke="none" />`,
      );
    } else if (centerlinePathD) {
      const dashAttr = style.dashArray ? ` stroke-dasharray="${escapeAttr(style.dashArray)}"` : '';
      parts.push(
        `<path d="${escapeAttr(centerlinePathD)}" fill="none" stroke="${escapeAttr(style.stroke)}" stroke-width="${round2(style.effectiveWidth)}" stroke-opacity="${style.effectiveOpacity}" stroke-linecap="round" stroke-linejoin="round"${dashAttr} />`,
      );
    }
  }

  return parts.join('');
}

/**
 * Pure DOM renderer for `drawing.freehand.stroke`.
 * Owns only the inner content inside `container` and never mutates canonical state or outer transforms.
 */
export function renderStrokeDom(container, props, derived, entityId) {
  if (!container) return () => {};
  const compiled = ensureDerived(props, derived, entityId);
  const w = Math.max(1, round2(compiled.width));
  const h = Math.max(1, round2(compiled.height));
  const inner = buildInnerStrokeSvgMarkup(compiled);
  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" data-brush="${escapeAttr(compiled.style.brush)}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" overflow="visible" style="display:block;width:100%;height:100%;overflow:visible;pointer-events:none">${inner}</svg>`;

  if (container.__alidFreehandLastSvg !== svgMarkup || container.innerHTML !== svgMarkup) {
    container.innerHTML = svgMarkup;
    container.__alidFreehandLastSvg = svgMarkup;
  }

  return () => {
    container.__alidFreehandLastSvg = '';
    container.innerHTML = '';
  };
}

/**
 * Pure SVG publication renderer (`renderSvg`) for `drawing.freehand.stroke`.
 * Operates completely without DOM or `<foreignObject>`.
 */
export function renderStrokeSvg(props, derived, entityId) {
  const compiled = ensureDerived(props, derived, entityId);
  const x = round2(finiteOr(compiled.x, 0));
  const y = round2(finiteOr(compiled.y, 0));
  const w = Math.max(1, round2(finiteOr(compiled.width, DEFAULT_BASE_WIDTH)));
  const h = Math.max(1, round2(finiteOr(compiled.height, DEFAULT_BASE_HEIGHT)));
  const deg = round2((finiteOr(compiled.rotation, 0) * 180) / Math.PI);
  const cx = round2(w * 0.5);
  const cy = round2(h * 0.5);
  const transformAttr =
    deg !== 0
      ? `translate(${x},${y}) rotate(${deg} ${cx} ${cy})`
      : `translate(${x},${y})`;

  const inner = buildInnerStrokeSvgMarkup(compiled);
  return {
    svg: `<g data-entity-id="${escapeAttr(entityId ?? '')}" data-brush="${escapeAttr(compiled.style.brush)}" transform="${transformAttr}">${inner}</g>`,
  };
}
