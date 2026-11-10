var extension_default = {
	id: "drawing.freehand",
	title: "자유 드로잉",
	version: "0.2.1",
	summary: "필압·속도 감응 자유곡선 브러시, 스트림라인 손떨림 보정, Shift 직선 스냅, 형광펜·점선·닫힌 도형을 지원하는 고성능 자유 드로잉 확장",
	engine: "^0.1.0",
	dependencies: {},
	optionalDependencies: { "core.select-suite": "^0.1.0" },
	conflicts: [],
	provides: {
		"services": [],
		"hsmSlots": []
	}
};
// src/manifest.js
var EXTENSION_ID = extension_default.id;
var STROKE_ASPECT_ID = `${EXTENSION_ID}.stroke`;
var FREEHAND_TOOL_STATE = `root.select.${EXTENSION_ID}`;
var COMMAND_NAMES = Object.freeze([
	"draw-tool",
	"insert-stroke",
	"simplify-stroke",
	"smooth-stroke",
	"toggle-close-stroke",
	"cycle-brush"
]);
var settingsSchema = Object.freeze([
	{
		key: "defaultBrush",
		label: "기본 브러시 종류",
		kind: "select",
		defaultValue: "pen",
		options: [
			{
				value: "pen",
				label: "필압 펜 (가변 굵기)"
			},
			{
				value: "fine",
				label: "정밀 모노라인 펜"
			},
			{
				value: "marker",
				label: "캘리그래피 마커"
			},
			{
				value: "highlighter",
				label: "형광펜 (반투명)"
			}
		]
	},
	{
		key: "defaultStroke",
		label: "기본 잉크 색상",
		kind: "select",
		defaultValue: "#17181c",
		options: [
			{
				value: "#17181c",
				label: "차콜 블랙 (#17181c)"
			},
			{
				value: "#3182f6",
				label: "블루 (#3182f6)"
			},
			{
				value: "#ef4444",
				label: "레드 (#ef4444)"
			},
			{
				value: "#10b981",
				label: "에메랄드 (#10b981)"
			},
			{
				value: "#f59e0b",
				label: "앰버 (#f59e0b)"
			},
			{
				value: "#8b5cf6",
				label: "바이올렛 (#8b5cf6)"
			}
		]
	},
	{
		key: "defaultStrokeWidth",
		label: "기본 브러시 굵기",
		kind: "number",
		defaultValue: 15,
		min: 1,
		max: 64,
		step: 1
	},
	{
		key: "defaultStreamline",
		label: "기본 손떨림 보정 (Streamline)",
		kind: "number",
		defaultValue: .5,
		min: 0,
		max: .95,
		step: .05
	},
	{
		key: "simplifyTolerance",
		label: "포인트 경량화 허용 오차 (RDP)",
		kind: "number",
		defaultValue: .65,
		min: 0,
		max: 4,
		step: .05
	},
	{
		key: "keepToolActive",
		label: "연속 드로잉 모드 (획 완료 후 도구 유지)",
		kind: "boolean",
		defaultValue: true
	}
]);
/** Shared by the bundle and build script; keep the reviewed and executed contracts identical. */
function createPackageManifest(metadata = extension_default) {
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
			hsmSlots: [...metadata.provides.hsmSlots]
		}
	};
}
var EXTENSION_MANIFEST = Object.freeze(createPackageManifest(extension_default));
// src/freehand.js
var BRUSH_TYPES = Object.freeze([
	"pen",
	"fine",
	"marker",
	"highlighter"
]);
var DASH_TYPES = Object.freeze([
	"solid",
	"dashed",
	"dotted"
]);
var MAX_STROKE_POINTS = 8192;
var RATE_OF_PRESSURE_CHANGE = .275;
var CAP_SEGMENTS = 12;
var CORNER_STEPS = 13;
var FIXED_PI = Math.PI + 1e-4;
function rotateAround(px, py, cx, cy, angle) {
	const s = Math.sin(angle);
	const c = Math.cos(angle);
	const dx = px - cx;
	const dy = py - cy;
	return {
		x: cx + dx * c - dy * s,
		y: cy + dx * s + dy * c
	};
}
var SAFE_COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i;
var DEFAULT_SAMPLE_POINTS = Object.freeze([
	Object.freeze({
		x: 8,
		y: 64,
		z: .35
	}),
	Object.freeze({
		x: 28,
		y: 26,
		z: .58
	}),
	Object.freeze({
		x: 56,
		y: 14,
		z: .76
	}),
	Object.freeze({
		x: 88,
		y: 46,
		z: .68
	}),
	Object.freeze({
		x: 118,
		y: 80,
		z: .62
	}),
	Object.freeze({
		x: 148,
		y: 62,
		z: .52
	}),
	Object.freeze({
		x: 172,
		y: 22,
		z: .32
	})
]);
var STROKE_DEFAULTS = Object.freeze({
	points: DEFAULT_SAMPLE_POINTS,
	segments: Object.freeze([]),
	baseWidth: 180,
	baseHeight: 96,
	brush: "pen",
	stroke: "#17181c",
	strokeWidth: 15,
	dash: "solid",
	thinning: .55,
	streamline: .5,
	smoothing: .5,
	taperStart: 0,
	taperEnd: 0,
	fill: "none",
	fillOpacity: .18,
	opacity: 1,
	isClosed: false,
	isPen: false
});
function round2(value) {
	return Math.round(value * 100) / 100;
}
function round3(value) {
	return Math.round(value * 1e3) / 1e3;
}
function clamp(value, min, max) {
	if (!Number.isFinite(value)) return min;
	return value < min ? min : value > max ? max : value;
}
function finiteOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function isValidHexColor(value) {
	return typeof value === "string" && /^#[\da-f]{6}$/i.test(value.trim());
}
function sanitizeColor(value, fallback = "#17181c") {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	if (trimmed === "none" || trimmed === "transparent") return trimmed;
	return SAFE_COLOR_PATTERN.test(trimmed) ? trimmed : fallback;
}
function normalizeBrush(value, fallback = "pen") {
	return typeof value === "string" && BRUSH_TYPES.includes(value) ? value : fallback;
}
function normalizeDash(value, fallback = "solid") {
	return typeof value === "string" && DASH_TYPES.includes(value) ? value : fallback;
}
/**
* Generates preset local stroke points and dimensions for quick insertion & Copilot tools.
*/
function createPresetStroke(preset = "wave") {
	switch (preset) {
		case "circle": {
			const points = [];
			const rx = 64;
			const ry = 60;
			const cx = 72;
			const cy = 68;
			const steps = 24;
			for (let i = 0; i <= steps; i++) {
				const angle = i / steps * Math.PI * 2;
				points.push({
					x: round2(cx + Math.cos(angle) * rx),
					y: round2(cy + Math.sin(angle) * ry),
					z: round3(.45 + .25 * Math.sin(angle * 2))
				});
			}
			return {
				points,
				segments: [],
				baseWidth: 144,
				baseHeight: 136,
				isClosed: true
			};
		}
		case "box": return {
			points: [
				{
					x: 8,
					y: 8,
					z: .6
				},
				{
					x: 172,
					y: 8,
					z: .65
				},
				{
					x: 172,
					y: 104,
					z: .65
				},
				{
					x: 8,
					y: 104,
					z: .65
				},
				{
					x: 8,
					y: 8,
					z: .6
				}
			],
			segments: [{
				type: "straight",
				startIndex: 0,
				endIndex: 4
			}],
			baseWidth: 180,
			baseHeight: 112,
			isClosed: true
		};
		case "underline": return {
			points: [
				{
					x: 6,
					y: 18,
					z: .35
				},
				{
					x: 58,
					y: 12,
					z: .65
				},
				{
					x: 124,
					y: 15,
					z: .75
				},
				{
					x: 188,
					y: 10,
					z: .68
				},
				{
					x: 234,
					y: 16,
					z: .28
				}
			],
			segments: [],
			baseWidth: 240,
			baseHeight: 28,
			isClosed: false
		};
		case "highlight": return {
			points: [
				{
					x: 10,
					y: 20,
					z: .5
				},
				{
					x: 110,
					y: 19,
					z: .5
				},
				{
					x: 210,
					y: 20,
					z: .5
				}
			],
			segments: [{
				type: "straight",
				startIndex: 0,
				endIndex: 2
			}],
			baseWidth: 220,
			baseHeight: 40,
			brush: "highlighter",
			stroke: "#f59e0b",
			strokeWidth: 18,
			isClosed: false
		};
		case "check": return {
			points: [
				{
					x: 10,
					y: 52,
					z: .42
				},
				{
					x: 38,
					y: 82,
					z: .78
				},
				{
					x: 68,
					y: 46,
					z: .66
				},
				{
					x: 112,
					y: 10,
					z: .32
				}
			],
			segments: [],
			baseWidth: 122,
			baseHeight: 92,
			isClosed: false
		};
		case "arrow": return {
			points: [
				{
					x: 8,
					y: 52,
					z: .4
				},
				{
					x: 72,
					y: 36,
					z: .65
				},
				{
					x: 148,
					y: 36,
					z: .72
				},
				{
					x: 122,
					y: 12,
					z: .55
				},
				{
					x: 154,
					y: 36,
					z: .75
				},
				{
					x: 122,
					y: 62,
					z: .45
				}
			],
			segments: [],
			baseWidth: 164,
			baseHeight: 74,
			isClosed: false
		};
		case "spiral": {
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
					z: round3(.35 + .45 * (1 - t * .5))
				});
			}
			return {
				points,
				segments: [],
				baseWidth: 144,
				baseHeight: 144,
				isClosed: false
			};
		}
		default: return {
			points: DEFAULT_SAMPLE_POINTS.map((p) => ({ ...p })),
			segments: [],
			baseWidth: 180,
			baseHeight: 96,
			isClosed: false
		};
	}
}
/**
* Sanitizes raw point lists into finite `{ x, y, z, seg }` records.
*/
function sanitizePoints(rawPoints, segments) {
	const straightFlags = new Uint8Array(MAX_STROKE_POINTS);
	if (Array.isArray(segments)) for (let s = 0; s < segments.length; s++) {
		const seg = segments[s];
		if (!seg || seg.type !== "straight") continue;
		const start = Math.max(0, Math.trunc(finiteOr(seg.startIndex, 0)));
		const end = Math.min(8191, Math.trunc(finiteOr(seg.endIndex, start)));
		for (let i = start + 1; i <= end; i++) straightFlags[i] = 1;
	}
	const out = [];
	if (Array.isArray(rawPoints)) {
		const limit = Math.min(rawPoints.length, MAX_STROKE_POINTS);
		for (let i = 0; i < limit; i++) {
			const pt = rawPoints[i];
			if (!pt || typeof pt !== "object") continue;
			const x = Number(pt.x);
			const y = Number(pt.y);
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			const z = clamp(finiteOr(Number(pt.z), .5), .01, 1);
			const seg = pt.seg === 1 || pt.segment === "straight" || straightFlags[i] === 1 ? 1 : 0;
			out.push({
				x,
				y,
				z,
				seg
			});
		}
	}
	if (out.length === 0) for (let i = 0; i < DEFAULT_SAMPLE_POINTS.length; i++) {
		const p = DEFAULT_SAMPLE_POINTS[i];
		out.push({
			x: p.x,
			y: p.y,
			z: p.z,
			seg: 0
		});
	}
	return out;
}
/**
* Iterative Ramer-Douglas-Peucker (RDP) stroke decimation in (x, y) space.
* Preserves segment mode boundaries (`seg === 1`) and endpoints without recursion.
*/
var rdpKeepMask = new Uint8Array(MAX_STROKE_POINTS);
var rdpStackLo = new Int32Array(MAX_STROKE_POINTS);
var rdpStackHi = new Int32Array(MAX_STROKE_POINTS);
function simplifyStrokePoints(points, tolerance = .65) {
	if (!Array.isArray(points) || points.length <= 3 || tolerance <= 0) return Array.isArray(points) ? points.slice() : [];
	const n = Math.min(points.length, MAX_STROKE_POINTS);
	const tolSq = tolerance * tolerance;
	rdpKeepMask.fill(0, 0, n);
	rdpKeepMask[0] = 1;
	rdpKeepMask[n - 1] = 1;
	for (let i = 1; i < n; i++) if ((points[i].seg ?? 0) === 1) {
		rdpKeepMask[i] = 1;
		rdpKeepMask[i - 1] = 1;
	}
	let sp = 0;
	let anchorStart = 0;
	for (let i = 1; i < n; i++) if (rdpKeepMask[i] === 1) {
		if (i - anchorStart > 1) {
			rdpStackLo[sp] = anchorStart;
			rdpStackHi[sp] = i;
			sp++;
		}
		anchorStart = i;
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
	for (let i = 0; i < n; i++) if (rdpKeepMask[i] === 1) simplified.push(points[i]);
	return simplified;
}
/**
* Rebounds world or arbitrary stroke points into normalized local `[0..baseWidth, 0..baseHeight]`
* coordinates and extracts contiguous straight-line segment ranges.
*/
function normalizeStrokeGeometry(rawPoints, options = {}) {
	const tol = finiteOr(options.simplifyTolerance, 0);
	const working = tol > 0 ? simplifyStrokePoints(rawPoints, tol) : rawPoints;
	if (!Array.isArray(working) || working.length === 0) return {
		x: 0,
		y: 0,
		width: 180,
		height: 96,
		baseWidth: 180,
		baseHeight: 96,
		points: DEFAULT_SAMPLE_POINTS.map((p) => ({ ...p })),
		segments: []
	};
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
		maxX = 180;
		maxY = 96;
	}
	const rawW = maxX - minX;
	const rawH = maxY - minY;
	const padX = rawW < 1 ? (1 - rawW) * .5 : 0;
	const padY = rawH < 1 ? (1 - rawH) * .5 : 0;
	const originX = minX - padX;
	const originY = minY - padY;
	const baseWidth = Math.max(1, round2(rawW + padX * 2));
	const baseHeight = Math.max(1, round2(rawH + padY * 2));
	const points = new Array(working.length);
	const segments = [];
	let segStart = -1;
	for (let i = 0; i < working.length; i++) {
		const p = working[i];
		const z = round3(clamp(finiteOr(p?.z, .5), .01, 1));
		points[i] = {
			x: round2(finiteOr(p?.x, originX) - originX),
			y: round2(finiteOr(p?.y, originY) - originY),
			z
		};
		if (p?.seg === 1 || p?.segment === "straight") {
			if (segStart < 0) segStart = Math.max(0, i - 1);
		} else if (segStart >= 0) {
			segments.push({
				type: "straight",
				startIndex: segStart,
				endIndex: i - 1
			});
			segStart = -1;
		}
	}
	if (segStart >= 0) segments.push({
		type: "straight",
		startIndex: segStart,
		endIndex: working.length - 1
	});
	return {
		x: round2(originX),
		y: round2(originY),
		width: baseWidth,
		height: baseHeight,
		baseWidth,
		baseHeight,
		points,
		segments
	};
}
/**
* Step 1 of tldraw / perfect-freehand pipeline:
* Converts raw input points into streamlined stroke points with running length and unit direction vectors.
*/
function getStrokePoints(rawPoints, options = {}) {
	const streamline = clamp(finiteOr(options.streamline, .5), 0, .95);
	const size = Math.max(1, finiteOr(options.size, 6));
	const isClosed = Boolean(options.isClosed);
	const t = .15 + (1 - streamline) * .85;
	const n = rawPoints.length;
	if (n === 0) return [];
	const pts = [];
	for (let i = 0; i < n; i++) {
		const p = rawPoints[i];
		if (i > 0 && p.seg === 1) {
			const prev = pts[pts.length - 1];
			const dx = p.x - prev.x;
			const dy = p.y - prev.y;
			const steps = Math.min(8, Math.max(1, Math.floor(Math.hypot(dx, dy) / Math.max(4, size * 1.5))));
			for (let s = 1; s <= steps; s++) {
				const u = s / steps;
				pts.push({
					x: prev.x + dx * u,
					y: prev.y + dy * u,
					z: prev.z + (p.z - prev.z) * u,
					seg: 1
				});
			}
		} else pts.push({
			x: p.x,
			y: p.y,
			z: p.z ?? .5,
			seg: p.seg ?? 0
		});
	}
	if (isClosed && pts.length >= 3) {
		const first = pts[0];
		const last = pts[pts.length - 1];
		if (Math.hypot(first.x - last.x, first.y - last.y) > .5) pts.push({
			x: first.x,
			y: first.y,
			z: first.z,
			seg: last.seg
		});
	}
	if (pts.length === 1) pts.push({
		x: pts[0].x + .01,
		y: pts[0].y + .01,
		z: pts[0].z,
		seg: 0
	});
	const strokePoints = [{
		x: pts[0].x,
		y: pts[0].y,
		pressure: clamp(pts[0].z, .01, 1),
		vx: 1,
		vy: 0,
		distance: 0,
		runningLength: 0,
		seg: pts[0].seg
	}];
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
		if (!isLast && distance < .05) continue;
		totalLength += distance;
		const invDist = distance > 1e-6 ? 1 / distance : 0;
		const nextPt = {
			x: ix,
			y: iy,
			pressure: clamp(curr.z, .01, 1),
			vx: distance > 1e-6 ? dx * invDist : prev.vx,
			vy: distance > 1e-6 ? dy * invDist : prev.vy,
			distance,
			runningLength: totalLength,
			seg: curr.seg
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
function getStrokeRadius(size, thinning, pressure) {
	if (thinning === 0) return size * .5;
	return size * clamp(.5 - thinning * (.5 - (.5 - Math.cos(pressure * Math.PI) * .5)), .08, 1);
}
/**
* Step 2 of tldraw / perfect-freehand pipeline:
* Generates the variable-width left/right offset polygon with caps and tapers.
*/
function getStrokeOutlinePoints(strokePoints, options = {}) {
	const n = strokePoints.length;
	if (n === 0) return [];
	const size = Math.max(1, finiteOr(options.size, 6));
	const thinning = clamp(finiteOr(options.thinning, .55), 0, .95);
	const smoothing = clamp(finiteOr(options.smoothing, .5), 0, 1);
	const simulatePressure = options.simulatePressure !== false;
	const taperStart = Math.max(0, finiteOr(options.taperStart, 0));
	const taperEnd = Math.max(0, finiteOr(options.taperEnd, 0));
	const isClosed = Boolean(options.isClosed);
	const totalLength = strokePoints[n - 1].runningLength;
	if (n === 1 || totalLength <= Math.max(1.2, size * .2)) {
		const center = strokePoints[0];
		const r = getStrokeRadius(size, thinning * .5, center.pressure);
		const circle = [];
		for (let i = 0; i < 16; i++) {
			const a = i / 16 * Math.PI * 2;
			circle.push({
				x: center.x + Math.cos(a) * r,
				y: center.y + Math.sin(a) * r
			});
		}
		return circle;
	}
	const minDistSq = Math.pow(size * smoothing * .3, 2);
	const leftPts = [];
	const rightPts = [];
	let prevPressure = strokePoints[0].pressure;
	for (let i = 0; i < Math.min(3, n); i++) {
		const pt = strokePoints[i];
		if (simulatePressure) {
			const sp = Math.min(1, pt.distance / size);
			const rp = Math.min(1, 1 - sp);
			prevPressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
		} else prevPressure = prevPressure + (pt.pressure - prevPressure) * .5;
	}
	let prevVx = strokePoints[0].vx;
	let prevVy = strokePoints[0].vy;
	let prevLx = strokePoints[0].x;
	let prevLy = strokePoints[0].y;
	let prevRx = strokePoints[0].x;
	let prevRy = strokePoints[0].y;
	let firstRadius = -1;
	let lastRadius = size * .5;
	let isPrevPointSharpCorner = false;
	for (let i = 0; i < n; i++) {
		const pt = strokePoints[i];
		const isLast = i === n - 1;
		if (!isLast && totalLength - pt.runningLength < 3) continue;
		let pressure = pt.pressure;
		if (thinning > 0) {
			if (simulatePressure) {
				const sp = Math.min(1, pt.distance / size);
				const rp = Math.min(1, 1 - sp);
				pressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
			} else pressure = prevPressure + (pressure - prevPressure) * .5;
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
		radius = Math.max(.25, radius);
		if (firstRadius < 0) firstRadius = radius;
		lastRadius = radius;
		const vx = pt.vx;
		const vy = pt.vy;
		const next = isLast ? pt : strokePoints[i + 1];
		const nextDpr = isLast ? 1 : vx * next.vx + vy * next.vy;
		const isPointSharpCorner = vx * prevVx + vy * prevVy < 0 && !isPrevPointSharpCorner;
		const isNextPointSharpCorner = nextDpr < 0;
		if (isPointSharpCorner || isNextPointSharpCorner) {
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
			rightPts.push({
				x: pt.x - ox,
				y: pt.y - oy
			});
			leftPts.push({
				x: pt.x + ox,
				y: pt.y + oy
			});
			continue;
		}
		const bx = next.vx + (vx - next.vx) * nextDpr;
		const ox = (next.vy + (vy - next.vy) * nextDpr) * radius;
		const oy = -bx * radius;
		const rx = pt.x - ox;
		const ry = pt.y - oy;
		const lx = pt.x + ox;
		const ly = pt.y + oy;
		if (i <= 1 || (lx - prevLx) * (lx - prevLx) + (ly - prevLy) * (ly - prevLy) > minDistSq) {
			leftPts.push({
				x: lx,
				y: ly
			});
			prevLx = lx;
			prevLy = ly;
		}
		if (i <= 1 || (rx - prevRx) * (rx - prevRx) + (ry - prevRy) * (ry - prevRy) > minDistSq) {
			rightPts.push({
				x: rx,
				y: ry
			});
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
		if (taperEnd > 0) endCap.push({
			x: endPt.x,
			y: endPt.y
		});
		else {
			const dx = lastL.x - lastR.x;
			const dy = lastL.y - lastR.y;
			const startAngle = Math.atan2(dy, dx);
			const front = Math.cos(startAngle + Math.PI * .5) * endPt.vx + Math.sin(startAngle + Math.PI * .5) * endPt.vy < 0 ? 1 : -1;
			for (let i = 1; i < CAP_SEGMENTS; i++) {
				const a = startAngle + front * (i / CAP_SEGMENTS) * Math.PI;
				endCap.push({
					x: endPt.x + Math.cos(a) * lastRadius,
					y: endPt.y + Math.sin(a) * lastRadius
				});
			}
		}
	}
	const startCap = [];
	if (!isClosed) {
		if (taperStart > 0) startCap.push({
			x: startPt.x,
			y: startPt.y
		});
		else {
			const dx = firstR.x - firstL.x;
			const dy = firstR.y - firstL.y;
			const startAngle = Math.atan2(dy, dx);
			const back = Math.cos(startAngle + Math.PI * .5) * startPt.vx + Math.sin(startAngle + Math.PI * .5) * startPt.vy > 0 ? 1 : -1;
			for (let i = 1; i < CAP_SEGMENTS; i++) {
				const a = startAngle + back * (i / CAP_SEGMENTS) * Math.PI;
				startCap.push({
					x: startPt.x + Math.cos(a) * firstRadius,
					y: startPt.y + Math.sin(a) * firstRadius
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
function getSvgPathFromStrokePoints(points, closed = true) {
	const n = points.length;
	if (n === 0) return "";
	if (n === 1) {
		const p = points[0];
		return `M ${round2(p.x)} ${round2(p.y)}`;
	}
	if (n === 2) {
		const a = points[0];
		const b = points[1];
		return `M ${round2(a.x)} ${round2(a.y)} L ${round2(b.x)} ${round2(b.y)}${closed ? " Z" : ""}`;
	}
	const p0 = points[0];
	const p1 = points[1];
	let d = `M ${round2(p0.x)} ${round2(p0.y)} Q ${round2(p1.x)} ${round2(p1.y)} ${round2((p1.x + points[2].x) * .5)} ${round2((p1.y + points[2].y) * .5)}`;
	for (let i = 2; i < n - 1; i++) {
		const curr = points[i];
		const next = points[i + 1];
		const mx = round2((curr.x + next.x) * .5);
		const my = round2((curr.y + next.y) * .5);
		d += ` T ${mx} ${my}`;
	}
	if (closed) {
		const last = points[n - 1];
		const first = points[0];
		d += ` Q ${round2(last.x)} ${round2(last.y)} ${round2((last.x + first.x) * .5)} ${round2((last.y + first.y) * .5)} Z`;
	} else {
		const last = points[n - 1];
		d += ` L ${round2(last.x)} ${round2(last.y)}`;
	}
	return d;
}
function createDotSvgPath(cx, cy, radius) {
	const r = Math.max(.5, round2(radius));
	const x0 = round2(cx - r);
	const y0 = round2(cy);
	const d2 = round2(r * 2);
	return `M ${x0} ${y0} a ${r} ${r} 0 1 0 ${d2} 0 a ${r} ${r} 0 1 0 ${-d2} 0 Z`;
}
/**
* Resolves effective brush parameters for a stroke aspect record.
*/
function resolveStrokeStyle(props = STROKE_DEFAULTS) {
	const brush = normalizeBrush(props?.brush, STROKE_DEFAULTS.brush);
	const dash = normalizeDash(props?.dash, STROKE_DEFAULTS.dash);
	const rawWidth = clamp(finiteOr(Number(props?.strokeWidth), STROKE_DEFAULTS.strokeWidth), 1, 64);
	const stroke = sanitizeColor(props?.stroke, STROKE_DEFAULTS.stroke);
	const fill = sanitizeColor(props?.fill, STROKE_DEFAULTS.fill);
	const fillOpacity = clamp(finiteOr(Number(props?.fillOpacity), STROKE_DEFAULTS.fillOpacity), 0, 1);
	const rawOpacity = clamp(finiteOr(Number(props?.opacity), STROKE_DEFAULTS.opacity), .05, 1);
	const streamline = clamp(finiteOr(Number(props?.streamline), STROKE_DEFAULTS.streamline), 0, .95);
	const smoothing = clamp(finiteOr(Number(props?.smoothing), STROKE_DEFAULTS.smoothing), 0, 1);
	const taperStart = clamp(finiteOr(Number(props?.taperStart), STROKE_DEFAULTS.taperStart), 0, 120);
	const taperEnd = clamp(finiteOr(Number(props?.taperEnd), STROKE_DEFAULTS.taperEnd), 0, 120);
	const isClosed = Boolean(props?.isClosed);
	const isPen = Boolean(props?.isPen);
	let effectiveWidth = rawWidth;
	let effectiveThinning = clamp(finiteOr(Number(props?.thinning), STROKE_DEFAULTS.thinning), 0, .95);
	let effectiveOpacity = rawOpacity;
	if (brush === "fine") effectiveThinning = 0;
	else if (brush === "marker") {
		effectiveWidth = round2(rawWidth * 1.25);
		effectiveThinning = Math.max(.68, effectiveThinning);
	} else if (brush === "highlighter") {
		effectiveWidth = round2(rawWidth * 2.1);
		effectiveThinning = 0;
		effectiveOpacity = round3(Math.min(rawOpacity, .42));
	}
	const useOutlinePolygon = dash === "solid" && effectiveThinning > 0 && (brush === "pen" || brush === "marker");
	const dashArray = dash === "dashed" ? `${round2(effectiveWidth * 2)} ${round2(effectiveWidth * 1.5)}` : dash === "dotted" ? `0.1 ${round2(effectiveWidth * 1.8)}` : "";
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
		useOutlinePolygon
	});
}
/**
* Compiles local scaled geometry for a stroke.
*/
function compileLocalStroke(props, width, height) {
	const style = resolveStrokeStyle(props);
	const baseWidth = Math.max(1, finiteOr(Number(props?.baseWidth), width));
	const baseHeight = Math.max(1, finiteOr(Number(props?.baseHeight), height));
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
			seg: p.seg
		};
	}
	const strokePoints = getStrokePoints(scaledPts, {
		size: style.effectiveWidth,
		streamline: style.streamline,
		isClosed: style.isClosed
	});
	const totalLength = strokePoints.length > 0 ? strokePoints[strokePoints.length - 1].runningLength : 0;
	const isDot = strokePoints.length <= 1 || totalLength <= Math.max(1.2, style.effectiveWidth * .2);
	let renderMode = "centerline-stroke";
	let outlinePoints = [];
	let outlinePathD = "";
	let centerlinePathD = "";
	let fillPathD = "";
	if (isDot) {
		renderMode = "dot";
		const center = strokePoints[0] ?? {
			x: width * .5,
			y: height * .5,
			pressure: .5
		};
		const dotRadius = getStrokeRadius(style.effectiveWidth, style.thinning * .5, style.isPen ? center.pressure : .65);
		outlinePathD = createDotSvgPath(center.x, center.y, dotRadius);
		centerlinePathD = outlinePathD;
		outlinePoints = getStrokeOutlinePoints([center], {
			size: style.effectiveWidth,
			thinning: style.thinning,
			simulatePressure: !style.isPen
		});
	} else {
		centerlinePathD = getSvgPathFromStrokePoints(strokePoints, style.isClosed);
		if (style.fill !== "none" && style.fill !== "transparent" && style.fillOpacity > 0 || style.isClosed) fillPathD = style.isClosed ? centerlinePathD : getSvgPathFromStrokePoints(strokePoints, true);
		if (style.useOutlinePolygon) {
			renderMode = "freehand-outline";
			outlinePoints = getStrokeOutlinePoints(strokePoints, {
				size: style.effectiveWidth,
				thinning: style.thinning,
				smoothing: style.smoothing,
				simulatePressure: !style.isPen,
				taperStart: style.taperStart,
				taperEnd: style.taperEnd,
				isClosed: style.isClosed
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
	const pad = style.effectiveWidth * .65 + 2;
	const localInkBounds = Object.freeze({
		x: round2(minX - pad),
		y: round2(minY - pad),
		width: round2(Math.max(1, maxX - minX + pad * 2)),
		height: round2(Math.max(1, maxY - minY + pad * 2))
	});
	return Object.freeze({
		style,
		baseWidth,
		baseHeight,
		isDot,
		renderMode,
		totalLength: round2(totalLength),
		localPoints: Object.freeze(strokePoints.map((p) => Object.freeze({
			x: round2(p.x),
			y: round2(p.y),
			pressure: round3(p.pressure)
		}))),
		localOutlinePoints: Object.freeze(outlinePoints.map((p) => Object.freeze({
			x: round2(p.x),
			y: round2(p.y)
		}))),
		outlinePathD,
		centerlinePathD,
		fillPathD,
		pathD: renderMode === "freehand-outline" || renderMode === "dot" ? outlinePathD : centerlinePathD,
		localInkBounds
	});
}
var localGeometryCache = /* @__PURE__ */ new WeakMap();
function getCachedLocalStroke(props, width, height) {
	if (props && typeof props === "object" && Object.isFrozen(props)) {
		const cached = localGeometryCache.get(props);
		if (cached && cached.width === width && cached.height === height) return cached.compiled;
		const compiled = compileLocalStroke(props, width, height);
		localGeometryCache.set(props, {
			width,
			height,
			compiled
		});
		return compiled;
	}
	return compileLocalStroke(props, width, height);
}
/**
* Pure `derive(props, entityId, view)` implementation for `drawing.freehand.stroke`.
*/
function deriveStrokeGeometry(props, entityId, view) {
	const transform = view?.getCanonical?.(entityId, "core.transform");
	const bounds = view?.getCanonical?.(entityId, "core.bounds");
	const baseWidth = Math.max(1, finiteOr(Number(props?.baseWidth), 180));
	const baseHeight = Math.max(1, finiteOr(Number(props?.baseHeight), 96));
	const x = finiteOr(transform?.x, 0);
	const y = finiteOr(transform?.y, 0);
	const rotation = finiteOr(transform?.rotation, 0);
	const width = typeof bounds?.width === "number" && Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : baseWidth;
	const height = typeof bounds?.height === "number" && Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : baseHeight;
	const local = getCachedLocalStroke(props ?? STROKE_DEFAULTS, width, height);
	const cx = x + width * .5;
	const cy = y + height * .5;
	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);
	const toWorld = (lx, ly) => {
		if (rotation === 0) return Object.freeze({
			x: round2(x + lx),
			y: round2(y + ly)
		});
		const dx = x + lx - cx;
		const dy = y + ly - cy;
		return Object.freeze({
			x: round2(cx + dx * cos - dy * sin),
			y: round2(cy + dx * sin + dy * cos)
		});
	};
	const sampledPoints = new Array(local.localPoints.length);
	for (let i = 0; i < local.localPoints.length; i++) {
		const p = local.localPoints[i];
		sampledPoints[i] = toWorld(p.x, p.y);
	}
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
		height: round2(Math.max(1, maxWY - minWY))
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
		inkBounds
	});
}
// src/draw-tool.js
var UI_SELECTOR = "input,textarea,select,button,[contenteditable=\"\"],[contenteditable=\"true\"],[contenteditable=\"plaintext-only\"],[data-canvas-ui],[data-text-editor]";
var SVG_NS = "http://www.w3.org/2000/svg";
var ANGLE_SNAP_RAD = Math.PI / 12;
var SELECT_IDLE_STATE = "root.select.core.select-suite:idle";
var LEGACY_SELECT_IDLE_STATE = "root.select.idle";
function getMachineStateId(stateMachine) {
	if (!stateMachine) return void 0;
	if (typeof stateMachine.stateId === "string") return stateMachine.stateId;
	if (typeof stateMachine.getState === "function") return stateMachine.getState();
}
function transitionMachineToIdle(stateMachine) {
	if (!stateMachine || typeof stateMachine.transition !== "function") return SELECT_IDLE_STATE;
	try {
		if (stateMachine.transition("root.select.core.select-suite:idle") !== false && getMachineStateId(stateMachine) === "root.select.core.select-suite:idle") return SELECT_IDLE_STATE;
	} catch {}
	try {
		stateMachine.transition(LEGACY_SELECT_IDLE_STATE);
	} catch {}
	return getMachineStateId(stateMachine) ?? "root.select.core.select-suite:idle";
}
/**
* Interactive tldraw-style Freehand Drawing Tool with:
* - Pre-allocated Float64Array / Uint8Array point buffers (0-GC hot path during pointermove)
* - Coalesced stylus/pointer event ingestion (`event.getCoalescedEvents()`)
* - Real pen pressure (`pointerType === 'pen'`) vs velocity-simulated pressure
* - Shift straight-line segment mode (with Ctrl/Meta 15° angle snap)
* - Alt / close-threshold loop closing
* - Single rAF latch via `canvas.frames`
* - Single-Undo commit via `canvas.creation.create()`
* - Korean/CJK IME triple guard & zero-commit Escape/cancel/blur recovery
*/
var FreeDrawTool = class {
	constructor(options) {
		this.options = options;
		this.active = false;
		this.drawing = false;
		this.pointerId = null;
		this.hasRealPressure = false;
		this.straightSegmentActive = false;
		this.willAutoClose = false;
		this.previewDirty = false;
		this.composing = false;
		this.compositionEndedAt = -Infinity;
		this.lastKeyEvent = null;
		this.lastKeyHandled = false;
		this.lastCreatedId = null;
		this.rawX = new Float64Array(MAX_STROKE_POINTS);
		this.rawY = new Float64Array(MAX_STROKE_POINTS);
		this.rawZ = new Float64Array(MAX_STROKE_POINTS);
		this.rawSeg = new Uint8Array(MAX_STROKE_POINTS);
		this.rawCount = 0;
		this.tmpPoint = {
			x: 0,
			y: 0
		};
		this.tmpOrigin = {
			x: 0,
			y: 0
		};
		this.rectLeft = 0;
		this.rectTop = 0;
		this.hudSvg = null;
		this.hudWorldGroup = null;
		this.hudFillPath = null;
		this.hudInkPath = null;
		this.hudCloseRing = null;
		this.ensureHudElements();
	}
	get surfaceElement() {
		return this.options?.surface?.element ?? this.options?.surface ?? null;
	}
	get hudElement() {
		return this.options?.hud ?? this.options?.surface?.hud ?? null;
	}
	ensureHudElements() {
		const hud = this.hudElement;
		if (!hud || typeof hud.ownerDocument?.createElementNS !== "function") return;
		if (this.hudSvg) return;
		const doc = hud.ownerDocument;
		const svg = doc.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "alid-freehand-hud");
		svg.dataset.canvasUi = "freehand-preview";
		svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;display:none";
		const group = doc.createElementNS(SVG_NS, "g");
		const fillPath = doc.createElementNS(SVG_NS, "path");
		fillPath.setAttribute("fill", "none");
		fillPath.setAttribute("stroke", "none");
		const inkPath = doc.createElementNS(SVG_NS, "path");
		inkPath.setAttribute("fill", "none");
		inkPath.setAttribute("stroke", "none");
		const closeRing = doc.createElementNS(SVG_NS, "circle");
		closeRing.setAttribute("fill", "rgba(49, 130, 246, 0.14)");
		closeRing.setAttribute("stroke", "#3182f6");
		closeRing.setAttribute("stroke-width", "1.5");
		closeRing.style.display = "none";
		group.append(fillPath, inkPath, closeRing);
		svg.append(group);
		hud.append(svg);
		this.hudSvg = svg;
		this.hudWorldGroup = group;
		this.hudFillPath = fillPath;
		this.hudInkPath = inkPath;
		this.hudCloseRing = closeRing;
	}
	isImeActive(event) {
		const now = typeof performance !== "undefined" ? performance.now() : Date.now();
		return this.composing || Boolean(event?.isComposing) || event?.keyCode === 229 || event?.key === "Process" || now - this.compositionEndedAt < 16;
	}
	updateSurfaceRect() {
		const rect = this.surfaceElement?.getBoundingClientRect?.();
		if (rect) {
			this.rectLeft = finiteOr(rect.left, 0);
			this.rectTop = finiteOr(rect.top, 0);
		}
	}
	getCamera() {
		const cam = this.options?.host?.getCamera?.();
		return {
			x: finiteOr(cam?.x, 0),
			y: finiteOr(cam?.y, 0),
			zoom: Math.max(.01, finiteOr(cam?.zoom, 1))
		};
	}
	getZoom() {
		const host = this.options?.host;
		if (typeof host?.getZoom === "function") return Math.max(.01, finiteOr(host.getZoom(), 1));
		return this.getCamera().zoom;
	}
	screenToWorldPoint(clientX, clientY, out) {
		const host = this.options?.host;
		if (typeof host?.screenToWorld === "function") {
			host.screenToWorld(clientX, clientY, out);
			return out;
		}
		const cam = this.getCamera();
		out.x = (clientX - this.rectLeft - cam.x) / cam.zoom;
		out.y = (clientY - this.rectTop - cam.y) / cam.zoom;
		return out;
	}
	updateHudTransform() {
		if (!this.hudWorldGroup) return;
		const host = this.options?.host;
		const zoom = this.getZoom();
		if (typeof host?.worldToScreen === "function") {
			const hudRect = this.hudElement?.getBoundingClientRect?.();
			const left = finiteOr(hudRect?.left, 0);
			const top = finiteOr(hudRect?.top, 0);
			host.worldToScreen(0, 0, this.tmpOrigin);
			const tx = finiteOr(this.tmpOrigin.x, 0) - left;
			const ty = finiteOr(this.tmpOrigin.y, 0) - top;
			this.hudWorldGroup.setAttribute("transform", `translate(${tx} ${ty}) scale(${zoom})`);
			return;
		}
		const cam = this.getCamera();
		this.hudWorldGroup.setAttribute("transform", `translate(${cam.x},${cam.y}) scale(${cam.zoom})`);
	}
	resolveActiveBrushProps() {
		const getPref = this.options?.getPreference;
		const base = {
			...STROKE_DEFAULTS,
			brush: getPref?.("defaultBrush", STROKE_DEFAULTS.brush) ?? STROKE_DEFAULTS.brush,
			stroke: getPref?.("defaultStroke", STROKE_DEFAULTS.stroke) ?? STROKE_DEFAULTS.stroke,
			strokeWidth: Number(getPref?.("defaultStrokeWidth", STROKE_DEFAULTS.strokeWidth) ?? STROKE_DEFAULTS.strokeWidth),
			streamline: Number(getPref?.("defaultStreamline", STROKE_DEFAULTS.streamline) ?? STROKE_DEFAULTS.streamline)
		};
		const selectedIds = this.options?.selection?.getSelection?.() ?? [];
		if (selectedIds.length > 0) {
			const existing = this.options?.world?.getCanonical?.(selectedIds[0], STROKE_ASPECT_ID);
			if (existing && typeof existing === "object") return {
				...base,
				brush: existing.brush ?? base.brush,
				stroke: existing.stroke ?? base.stroke,
				strokeWidth: existing.strokeWidth ?? base.strokeWidth,
				dash: existing.dash ?? base.dash,
				thinning: existing.thinning ?? base.thinning,
				streamline: existing.streamline ?? base.streamline,
				smoothing: existing.smoothing ?? base.smoothing,
				taperStart: existing.taperStart ?? base.taperStart,
				taperEnd: existing.taperEnd ?? base.taperEnd,
				fill: existing.fill ?? base.fill,
				fillOpacity: existing.fillOpacity ?? base.fillOpacity,
				opacity: existing.opacity ?? base.opacity
			};
		}
		return base;
	}
	enter() {
		this.options?.selection?.select?.(null);
		this.options?.selection?.clear?.();
		const machine = this.options?.selection?.stateMachine;
		if (machine && typeof machine.transition === "function") machine.transition(FREEHAND_TOOL_STATE);
		else this.active = true;
		return FREEHAND_TOOL_STATE;
	}
	exit() {
		return transitionMachineToIdle(this.options?.selection?.stateMachine);
	}
	toggle() {
		const machine = this.options?.selection?.stateMachine;
		if (this.active || getMachineStateId(machine) === FREEHAND_TOOL_STATE) return this.exit();
		return this.enter();
	}
	createStateNode() {
		return {
			id: FREEHAND_TOOL_STATE,
			onEnter: () => {
				this.active = true;
				this.resetDraft();
				const surface = this.surfaceElement;
				if (surface) {
					if (surface.dataset) surface.dataset.activeTool = EXTENSION_ID;
					if (surface.style) surface.style.cursor = "crosshair";
				}
				this.syncHudVisibility();
				this.options?.host?.requestRender?.();
			},
			onExit: () => {
				const pending = this.drawing ? this.takeDraft() : null;
				this.abortDraft();
				this.active = false;
				if (pending) queueMicrotask(() => this.commitDraft(pending, { reenter: false }));
				const surface = this.surfaceElement;
				if (surface) {
					if (surface.dataset?.activeTool === EXTENSION_ID) delete surface.dataset.activeTool;
					if (surface.style?.cursor === "crosshair") surface.style.cursor = "";
				}
				this.syncHudVisibility();
				this.options?.host?.requestRender?.();
			},
			onEvent: (event) => {
				if (!event || typeof event.type !== "string") return false;
				if (event.type === "escape" || event.type === "cancel") {
					if (this.drawing) {
						this.abortDraft();
						return true;
					}
					this.exit();
					return true;
				}
				if (event.type === "enter" || event.type === "complete") {
					if (this.drawing) {
						this.finishDraft();
						return true;
					}
					return false;
				}
				return false;
			}
		};
	}
	onPointerDown = (event) => {
		if (!this.active) return;
		if (this.drawing) {
			if (event.pointerId === this.pointerId) return;
			if (event.pointerType === "touch") this.finishDraft();
			return;
		}
		if (event.button !== 0) return;
		const surface = this.surfaceElement;
		if (surface && event.target && typeof surface.contains === "function" && event.target !== surface && !surface.contains(event.target)) return;
		if (this.options?.host?.isSelectionEnabled?.() === false) return;
		if (this.options?.host?.isPanGesture?.(event)) return;
		if (typeof event.target?.closest === "function" && event.target.closest(UI_SELECTOR)) return;
		this.updateSurfaceRect();
		const pt = this.screenToWorldPoint(event.clientX, event.clientY, this.tmpPoint);
		const wx = pt.x;
		const wy = pt.y;
		if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
		const isPenEvent = event.pointerType === "pen" && typeof event.pressure === "number" && event.pressure > 0;
		const pressure = isPenEvent ? clamp(event.pressure, .02, 1) : .5;
		this.drawing = true;
		this.pointerId = event.pointerId;
		this.hasRealPressure = isPenEvent;
		this.straightSegmentActive = false;
		this.willAutoClose = false;
		this.activeStyleProps = this.resolveActiveBrushProps();
		this.rawX[0] = wx;
		this.rawY[0] = wy;
		this.rawZ[0] = pressure;
		this.rawSeg[0] = 0;
		this.rawCount = 1;
		try {
			this.surfaceElement?.setPointerCapture?.(event.pointerId);
		} catch {}
		event.preventDefault?.();
		event.stopImmediatePropagation?.();
		surface?.focus?.({ preventScroll: true });
		this.previewDirty = true;
		this.syncHudVisibility();
		this.flushFrame();
		this.options?.host?.requestRender?.();
	};
	/**
	* 0-GC hot path: appends coalesced coordinates into pre-allocated Float64Arrays
	* and schedules a single rAF render latch.
	*/
	onPointerMove = (event) => {
		if (!this.active || !this.drawing) return;
		if (this.pointerId !== null && event.pointerId !== void 0 && event.pointerId !== this.pointerId) return;
		event.preventDefault?.();
		event.stopImmediatePropagation?.();
		const zoom = this.getZoom();
		const minDist = Math.max(.28, 1.2 / zoom);
		const minDistSq = minDist * minDist;
		const shiftHeld = Boolean(event.shiftKey);
		const snapAngle = Boolean(event.ctrlKey || event.metaKey);
		const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : null;
		const count = coalesced && coalesced.length > 0 ? coalesced.length : 1;
		for (let i = 0; i < count; i++) {
			const sample = coalesced && coalesced.length > 0 ? coalesced[i] : event;
			const pt = this.screenToWorldPoint(sample.clientX, sample.clientY, this.tmpPoint);
			let wx = pt.x;
			let wy = pt.y;
			if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
			const isPenSample = (sample.pointerType === "pen" || this.hasRealPressure) && typeof sample.pressure === "number" && sample.pressure > 0;
			if (isPenSample) this.hasRealPressure = true;
			const wz = isPenSample ? clamp(sample.pressure, .02, 1) : .5;
			const lastIdx = this.rawCount - 1;
			if (shiftHeld) {
				const anchorIdx = this.straightSegmentActive ? Math.max(0, lastIdx - 1) : lastIdx;
				const ax = this.rawX[anchorIdx];
				const ay = this.rawY[anchorIdx];
				if (snapAngle) {
					const dx = wx - ax;
					const dy = wy - ay;
					const len = Math.hypot(dx, dy);
					if (len > 1e-4) {
						const snapped = Math.round(Math.atan2(dy, dx) / ANGLE_SNAP_RAD) * ANGLE_SNAP_RAD;
						wx = ax + Math.cos(snapped) * len;
						wy = ay + Math.sin(snapped) * len;
					}
				}
				if (!this.straightSegmentActive) {
					if (this.rawCount < 8192) {
						this.rawX[this.rawCount] = wx;
						this.rawY[this.rawCount] = wy;
						this.rawZ[this.rawCount] = wz;
						this.rawSeg[this.rawCount] = 1;
						this.rawCount++;
						this.straightSegmentActive = true;
					}
				} else {
					this.rawX[lastIdx] = wx;
					this.rawY[lastIdx] = wy;
					this.rawZ[lastIdx] = wz;
					this.rawSeg[lastIdx] = 1;
				}
				this.previewDirty = true;
				continue;
			}
			if (this.straightSegmentActive) this.straightSegmentActive = false;
			const dx = wx - this.rawX[lastIdx];
			const dy = wy - this.rawY[lastIdx];
			if (dx * dx + dy * dy < minDistSq) {
				if (isPenSample && Math.abs(wz - this.rawZ[lastIdx]) > .04) {
					this.rawZ[lastIdx] = wz;
					this.previewDirty = true;
				}
				continue;
			}
			if (this.rawCount < 8192) {
				this.rawX[this.rawCount] = wx;
				this.rawY[this.rawCount] = wy;
				this.rawZ[this.rawCount] = wz;
				this.rawSeg[this.rawCount] = 0;
				this.rawCount++;
				this.previewDirty = true;
			}
		}
		if (this.rawCount >= 6) {
			const styleWidth = finiteOr(this.activeStyleProps?.strokeWidth, STROKE_DEFAULTS.strokeWidth);
			const closeThreshold = Math.max(10 / zoom, styleWidth * 1.6);
			const endX = this.rawX[this.rawCount - 1];
			const endY = this.rawY[this.rawCount - 1];
			const distToStart = Math.hypot(endX - this.rawX[0], endY - this.rawY[0]);
			this.willAutoClose = Boolean(event.altKey) && distToStart <= closeThreshold;
		} else this.willAutoClose = false;
		if (this.previewDirty) this.options?.host?.requestRender?.();
	};
	onPointerUp = (event) => {
		if (!this.active || !this.drawing) return;
		if (this.pointerId !== null && event.pointerId !== void 0 && event.pointerId !== this.pointerId) return;
		event.preventDefault?.();
		event.stopImmediatePropagation?.();
		this.releaseCapture(event.pointerId);
		this.finishDraft();
	};
	onPointerCancel = (event) => {
		if (!this.drawing) return;
		if (this.pointerId !== null && event?.pointerId !== void 0 && event.pointerId !== this.pointerId) return;
		this.releaseCapture(event?.pointerId ?? this.pointerId);
		this.finishDraft();
	};
	onLostPointerCapture = (event) => {
		if (!this.drawing) return;
		if (this.pointerId !== null && event?.pointerId !== void 0 && event.pointerId !== this.pointerId) return;
		this.finishDraft();
	};
	onWindowBlur = () => {
		this.composing = false;
		if (this.drawing) this.finishDraft();
	};
	onKeyDown = (event) => {
		if (!this.active) return false;
		if (event && this.lastKeyEvent === event) return this.lastKeyHandled === true;
		this.lastKeyEvent = event;
		const handled = this.handleKeyDownOnce(event);
		this.lastKeyHandled = handled;
		return handled;
	};
	handleKeyDownOnce = (event) => {
		if (this.isImeActive(event)) return false;
		if (typeof event.target?.closest === "function" && event.target.closest(UI_SELECTOR)) return false;
		if (event.key === "Escape") {
			event.preventDefault?.();
			event.stopPropagation?.();
			if (this.drawing) this.abortDraft();
			else this.exit();
			return true;
		}
		if (event.key === "Enter" && this.drawing) {
			event.preventDefault?.();
			event.stopPropagation?.();
			this.finishDraft();
			return true;
		}
		if ((event.key === "[" || event.key === "]") && !event.ctrlKey && !event.metaKey && !event.altKey) {
			const delta = event.key === "]" ? 2 : -2;
			const next = clamp(finiteOr(this.options?.getPreference?.("defaultStrokeWidth", STROKE_DEFAULTS.strokeWidth), STROKE_DEFAULTS.strokeWidth) + delta, 1, 64);
			this.options?.setPreference?.("defaultStrokeWidth", next);
			if (this.activeStyleProps) {
				this.activeStyleProps = {
					...this.activeStyleProps,
					strokeWidth: next
				};
				this.previewDirty = true;
				this.options?.host?.requestRender?.();
			}
			return true;
		}
		return false;
	};
	onCompositionStart = () => {
		this.composing = true;
	};
	onCompositionEnd = () => {
		this.composing = false;
		this.compositionEndedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
	};
	releaseCapture(pointerId) {
		if (pointerId === null || pointerId === void 0) return;
		try {
			const surface = this.surfaceElement;
			if (surface?.hasPointerCapture?.(pointerId)) surface.releasePointerCapture(pointerId);
		} catch {}
	}
	resetDraft() {
		this.drawing = false;
		this.pointerId = null;
		this.hasRealPressure = false;
		this.straightSegmentActive = false;
		this.willAutoClose = false;
		this.rawCount = 0;
		this.previewDirty = false;
		if (this.hudFillPath) this.hudFillPath.setAttribute("d", "");
		if (this.hudInkPath) this.hudInkPath.setAttribute("d", "");
		if (this.hudCloseRing) this.hudCloseRing.style.display = "none";
	}
	abortDraft() {
		this.releaseCapture(this.pointerId);
		this.resetDraft();
		this.syncHudVisibility();
		this.options?.host?.requestRender?.();
	}
	finishDraft() {
		if (!this.drawing || this.rawCount === 0) {
			this.resetDraft();
			this.syncHudVisibility();
			return null;
		}
		const draft = this.takeDraft();
		this.releaseCapture(this.pointerId);
		this.resetDraft();
		this.syncHudVisibility();
		return this.commitDraft(draft, { reenter: true });
	}
	/** Copy the live draft out of the reusable buffers so it survives a reset. */
	takeDraft() {
		const rawPoints = new Array(this.rawCount);
		for (let i = 0; i < this.rawCount; i++) rawPoints[i] = {
			x: this.rawX[i],
			y: this.rawY[i],
			z: this.rawZ[i],
			seg: this.rawSeg[i]
		};
		return {
			rawPoints,
			isPen: this.hasRealPressure,
			isClosed: Boolean(this.willAutoClose || this.activeStyleProps?.isClosed),
			baseProps: this.activeStyleProps ?? this.resolveActiveBrushProps(),
			zoom: this.getZoom()
		};
	}
	commitDraft(draft, { reenter }) {
		if (!draft || draft.rawPoints.length === 0) return null;
		const { rawPoints, isPen, isClosed, baseProps, zoom } = draft;
		const normalized = normalizeStrokeGeometry(rawPoints, { simplifyTolerance: 0 });
		const strokeProps = {
			...STROKE_DEFAULTS,
			...baseProps,
			points: normalized.points,
			segments: normalized.segments,
			baseWidth: normalized.baseWidth,
			baseHeight: normalized.baseHeight,
			isClosed,
			isPen
		};
		const creation = this.options?.creation;
		if (!creation?.create) return null;
		let createdId = null;
		try {
			createdId = creation.create({
				caller: `${EXTENSION_ID}:draw-tool`,
				x: normalized.x,
				y: normalized.y,
				width: normalized.width,
				height: normalized.height,
				aspects: { [STROKE_ASPECT_ID]: strokeProps }
			});
		} catch (error) {
			this.options?.host?.onError?.(error instanceof Error ? error : new Error(String(error)));
			if (!this.options?.host?.onError) console.error("[drawing.freehand] stroke commit failed", error);
			if (reenter) this.enter();
			return null;
		}
		this.lastCreatedId = createdId;
		if (!reenter) {
			this.options?.host?.requestRender?.();
			return createdId;
		}
		if (this.options?.getPreference?.("keepToolActive", true) !== false) this.enter();
		else {
			this.options?.selection?.select?.(createdId);
			this.exit();
		}
		this.options?.host?.requestRender?.();
		return createdId;
	}
	syncHudVisibility() {
		if (!this.hudSvg) return;
		this.hudSvg.style.display = this.active && this.drawing ? "block" : "none";
	}
	/**
	* Called once per animation frame (`canvas.frames`) to update the live HUD preview path.
	*/
	flushFrame = () => {
		if (!this.active || !this.drawing || !this.hudSvg) return;
		this.updateHudTransform();
		const zoom = this.getZoom();
		if (!this.previewDirty) return;
		this.previewDirty = false;
		const n = this.rawCount;
		if (n === 0) return;
		const style = resolveStrokeStyle({
			...this.activeStyleProps ?? STROKE_DEFAULTS,
			isClosed: Boolean(this.willAutoClose || this.activeStyleProps?.isClosed),
			isPen: this.hasRealPressure
		});
		const pts = new Array(n);
		for (let i = 0; i < n; i++) pts[i] = {
			x: this.rawX[i],
			y: this.rawY[i],
			z: this.rawZ[i],
			seg: this.rawSeg[i]
		};
		const strokePoints = getStrokePoints(pts, {
			size: style.effectiveWidth,
			streamline: style.streamline,
			isClosed: style.isClosed
		});
		const totalLen = strokePoints.length > 0 ? strokePoints[strokePoints.length - 1].runningLength : 0;
		const isDot = strokePoints.length <= 1 || totalLen <= Math.max(1.2, style.effectiveWidth * .2);
		if (style.fill !== "none" && style.fill !== "transparent" && style.fillOpacity > 0 && strokePoints.length >= 3) {
			const fillD = getSvgPathFromStrokePoints(strokePoints, true);
			this.hudFillPath.setAttribute("d", fillD);
			this.hudFillPath.setAttribute("fill", style.fill);
			this.hudFillPath.setAttribute("fill-opacity", String(round2(style.fillOpacity * style.effectiveOpacity)));
		} else this.hudFillPath.setAttribute("d", "");
		if (isDot) {
			const c = strokePoints[0] ?? pts[0];
			const r = getStrokeRadius(style.effectiveWidth, style.thinning * .5, style.isPen ? c.pressure : .65);
			this.hudInkPath.setAttribute("d", createDotSvgPath(c.x, c.y, r));
			this.hudInkPath.setAttribute("fill", style.stroke);
			this.hudInkPath.setAttribute("fill-opacity", String(style.effectiveOpacity));
			this.hudInkPath.setAttribute("stroke", "none");
		} else if (style.useOutlinePolygon) {
			const outline = getStrokeOutlinePoints(strokePoints, {
				size: style.effectiveWidth,
				thinning: style.thinning,
				smoothing: style.smoothing,
				simulatePressure: !style.isPen,
				taperStart: style.taperStart,
				taperEnd: style.taperEnd,
				isClosed: style.isClosed
			});
			this.hudInkPath.setAttribute("d", getSvgPathFromStrokePoints(outline, true));
			this.hudInkPath.setAttribute("fill", style.stroke);
			this.hudInkPath.setAttribute("fill-opacity", String(style.effectiveOpacity));
			this.hudInkPath.setAttribute("stroke", "none");
		} else {
			this.hudInkPath.setAttribute("d", getSvgPathFromStrokePoints(strokePoints, style.isClosed));
			this.hudInkPath.setAttribute("fill", "none");
			this.hudInkPath.setAttribute("stroke", style.stroke);
			this.hudInkPath.setAttribute("stroke-width", String(round2(style.effectiveWidth)));
			this.hudInkPath.setAttribute("stroke-opacity", String(style.effectiveOpacity));
			this.hudInkPath.setAttribute("stroke-linecap", "round");
			this.hudInkPath.setAttribute("stroke-linejoin", "round");
			if (style.dashArray) this.hudInkPath.setAttribute("stroke-dasharray", style.dashArray);
			else this.hudInkPath.removeAttribute("stroke-dasharray");
		}
		if (this.willAutoClose && this.hudCloseRing) {
			this.hudCloseRing.setAttribute("cx", String(round2(this.rawX[0])));
			this.hudCloseRing.setAttribute("cy", String(round2(this.rawY[0])));
			this.hudCloseRing.setAttribute("r", String(round2(Math.max(8 / zoom, style.effectiveWidth))));
			this.hudCloseRing.style.display = "block";
		} else if (this.hudCloseRing) this.hudCloseRing.style.display = "none";
	};
	mount() {
		const surface = this.surfaceElement;
		if (!surface || typeof surface.addEventListener !== "function") return () => {};
		const doc = surface.ownerDocument ?? (typeof document !== "undefined" ? document : null);
		const win = doc?.defaultView ?? (typeof window !== "undefined" ? window : null);
		doc?.addEventListener?.("pointerdown", this.onPointerDown, { capture: true });
		surface.addEventListener("pointermove", this.onPointerMove, { capture: true });
		surface.addEventListener("pointerup", this.onPointerUp, { capture: true });
		surface.addEventListener("pointercancel", this.onPointerCancel, { capture: true });
		surface.addEventListener("lostpointercapture", this.onLostPointerCapture, { capture: true });
		win?.addEventListener?.("keydown", this.onKeyDown, true);
		win?.addEventListener?.("compositionstart", this.onCompositionStart, true);
		win?.addEventListener?.("compositionend", this.onCompositionEnd, true);
		win?.addEventListener?.("blur", this.onWindowBlur);
		return () => {
			doc?.removeEventListener?.("pointerdown", this.onPointerDown, { capture: true });
			surface.removeEventListener("pointermove", this.onPointerMove, { capture: true });
			surface.removeEventListener("pointerup", this.onPointerUp, { capture: true });
			surface.removeEventListener("pointercancel", this.onPointerCancel, { capture: true });
			surface.removeEventListener("lostpointercapture", this.onLostPointerCapture, { capture: true });
			win?.removeEventListener?.("keydown", this.onKeyDown, true);
			win?.removeEventListener?.("compositionstart", this.onCompositionStart, true);
			win?.removeEventListener?.("compositionend", this.onCompositionEnd, true);
			win?.removeEventListener?.("blur", this.onWindowBlur);
		};
	}
	dispose() {
		this.abortDraft();
		this.hudSvg?.remove?.();
		this.hudSvg = null;
		this.hudWorldGroup = null;
		this.hudFillPath = null;
		this.hudInkPath = null;
		this.hudCloseRing = null;
	}
};
// src/renderers.js
function escapeAttr(value) {
	return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}
function ensureDerived(props, derived, entityId) {
	if (derived && typeof derived.pathD === "string" && derived.style) return derived;
	const syntheticTransform = {
		x: finiteOr(derived?.x, 0),
		y: finiteOr(derived?.y, 0),
		rotation: finiteOr(derived?.rotation, 0)
	};
	const syntheticBounds = {
		width: Math.max(1, finiteOr(derived?.width, finiteOr(props?.baseWidth, 180))),
		height: Math.max(1, finiteOr(derived?.height, finiteOr(props?.baseHeight, 96)))
	};
	return deriveStrokeGeometry(props ?? STROKE_DEFAULTS, entityId, { getCanonical(_id, aspectId) {
		if (aspectId === "core.transform") return syntheticTransform;
		if (aspectId === "core.bounds") return syntheticBounds;
	} });
}
/**
* Builds the inner SVG paths for a compiled stroke in local `[0..width, 0..height]` coordinates.
*/
function buildInnerStrokeSvgMarkup(compiled) {
	const { style, renderMode, outlinePathD, centerlinePathD, fillPathD } = compiled;
	const parts = [];
	if (fillPathD && style.fill !== "none" && style.fill !== "transparent" && style.fillOpacity > 0) parts.push(`<path class="alid-freehand-fill" d="${escapeAttr(fillPathD)}" fill="${escapeAttr(style.fill)}" fill-opacity="${round2(style.fillOpacity * style.effectiveOpacity)}" stroke="none" />`);
	if (style.stroke !== "none" && style.stroke !== "transparent" && style.effectiveWidth > 0) {
		if (renderMode === "freehand-outline" || renderMode === "dot") parts.push(`<path class="alid-freehand-ink" d="${escapeAttr(outlinePathD)}" fill="${escapeAttr(style.stroke)}" fill-opacity="${style.effectiveOpacity}" stroke="none" />`);
		else if (centerlinePathD) {
			const dashAttr = style.dashArray ? ` stroke-dasharray="${escapeAttr(style.dashArray)}"` : "";
			parts.push(`<path class="alid-freehand-ink" d="${escapeAttr(centerlinePathD)}" fill="none" stroke="${escapeAttr(style.stroke)}" stroke-width="${round2(style.effectiveWidth)}" stroke-opacity="${style.effectiveOpacity}" stroke-linecap="round" stroke-linejoin="round"${dashAttr} />`);
		}
	}
	return parts.join("");
}
/**
* Pure DOM renderer for `drawing.freehand.stroke`.
* Owns only the inner content inside `container` and never mutates canonical state or outer transforms.
*/
function renderStrokeDom(container, props, derived, entityId) {
	if (!container) return () => {};
	const compiled = ensureDerived(props, derived, entityId);
	const w = Math.max(1, round2(compiled.width));
	const h = Math.max(1, round2(compiled.height));
	const inner = buildInnerStrokeSvgMarkup(compiled);
	const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" class="alid-freehand-svg" data-brush="${escapeAttr(compiled.style.brush)}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" overflow="visible" style="display:block;width:100%;height:100%;overflow:visible;pointer-events:none">${inner}</svg>`;
	if (container.__alidFreehandLastSvg !== svgMarkup || container.innerHTML !== svgMarkup) {
		container.innerHTML = svgMarkup;
		container.__alidFreehandLastSvg = svgMarkup;
	}
	return () => {
		container.__alidFreehandLastSvg = "";
		container.innerHTML = "";
	};
}
/**
* Pure SVG publication renderer (`renderSvg`) for `drawing.freehand.stroke`.
* Operates completely without DOM or `<foreignObject>`.
*/
function renderStrokeSvg(props, derived, entityId) {
	const compiled = ensureDerived(props, derived, entityId);
	const x = round2(finiteOr(compiled.x, 0));
	const y = round2(finiteOr(compiled.y, 0));
	const w = Math.max(1, round2(finiteOr(compiled.width, 180)));
	const h = Math.max(1, round2(finiteOr(compiled.height, 96)));
	const deg = round2(finiteOr(compiled.rotation, 0) * 180 / Math.PI);
	const cx = round2(w * .5);
	const cy = round2(h * .5);
	const transformAttr = deg !== 0 ? `translate(${x},${y}) rotate(${deg} ${cx} ${cy})` : `translate(${x},${y})`;
	const inner = buildInnerStrokeSvgMarkup(compiled);
	return { svg: `<g class="alid-freehand-export" data-entity-id="${escapeAttr(entityId ?? "")}" data-brush="${escapeAttr(compiled.style.brush)}" transform="${transformAttr}">${inner}</g>` };
}
// src/selection.js
var COMPUTED_STROKE_ID = `computed.${STROKE_ASPECT_ID}`;
function readGeometry(id, view) {
	if (!view || typeof view.isAlive !== "function" || !view.isAlive(id)) return void 0;
	if (!view.getCanonical?.(id, STROKE_ASPECT_ID)) return void 0;
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
		if (yi > py !== yj > py && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
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
function createStrokeSelectionContribution() {
	return {
		priority: 20,
		getBounds(id, view, out) {
			const geometry = readGeometry(id, view);
			if (!geometry || !geometry.sampledPoints?.length) return false;
			if (geometry.isDot) {
				const size = Math.max(geometry.style.effectiveWidth, 1);
				const p = geometry.sampledPoints[0];
				out.x = p.x - size * .5;
				out.y = p.y - size * .5;
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
			if (!geometry || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) return Infinity;
			const tolerance = 8 / zoom;
			const ib = geometry.inkBounds;
			if (ib && (x < ib.x - tolerance || x > ib.x + ib.width + tolerance || y < ib.y - tolerance || y > ib.y + ib.height + tolerance)) return Infinity;
			const { style, sampledPoints } = geometry;
			const n = sampledPoints.length;
			if (n === 0) return Infinity;
			if (style.fill !== "none" && style.fill !== "transparent" && style.fillOpacity > 0 && pointInPolygon(x, y, sampledPoints)) return 0;
			const halfWidth = style.effectiveWidth * .5;
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
			if (!geometry || !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY) || minX > maxX || minY > maxY) return false;
			const ib = geometry.inkBounds;
			if (ib && (ib.x + ib.width < minX || ib.x > maxX || ib.y + ib.height < minY || ib.y > maxY)) return false;
			const { style, sampledPoints } = geometry;
			const n = sampledPoints.length;
			if (n === 0) return false;
			const half = style.effectiveWidth * .5;
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
				if (segmentIntersectsBox(a.x, a.y, b.x, b.y, exMinX, exMinY, exMaxX, exMaxY)) return true;
			}
			if (style.isClosed && n > 2) {
				const a = sampledPoints[n - 1];
				const b = sampledPoints[0];
				if (segmentIntersectsBox(a.x, a.y, b.x, b.y, exMinX, exMinY, exMaxX, exMaxY)) return true;
			}
			if (style.fill !== "none" && style.fill !== "transparent" && style.fillOpacity > 0 && pointInPolygon((minX + maxX) * .5, (minY + maxY) * .5, sampledPoints)) return true;
			return false;
		},
		canTransform(id, view) {
			return Boolean(readGeometry(id, view));
		},
		canResize(id, view) {
			return Boolean(readGeometry(id, view));
		},
		canRotate(id, view) {
			return Boolean(readGeometry(id, view));
		}
	};
}
function parseHexToRgba(hex) {
	if (typeof hex !== "string" || !/^#[\da-f]{6}$/i.test(hex)) return null;
	const value = Number.parseInt(hex.slice(1), 16);
	return [
		(value >> 16 & 255) / 255,
		(value >> 8 & 255) / 255,
		(value & 255) / 255,
		1
	];
}
/**
* Optional GPU polyline contribution for uniform-width opaque solid strokes.
*/
function createStrokeGpuContribution() {
	return {
		aspectId: STROKE_ASPECT_ID,
		getPolyline(entityId, view) {
			const geometry = readGeometry(entityId, view);
			if (!geometry || geometry.isDot) return void 0;
			const { style, sampledPoints } = geometry;
			if (style.useOutlinePolygon || style.thinning > 0 || style.dash !== "solid" || style.effectiveOpacity !== 1 || style.isClosed || style.fill !== "none" && style.fill !== "transparent" && style.fillOpacity > 0 || sampledPoints.length < 2) return;
			const color = parseHexToRgba(style.stroke);
			if (!color) return void 0;
			return {
				points: sampledPoints,
				strokeWidth: style.effectiveWidth,
				strokeCap: "round",
				strokeJoin: "round",
				color
			};
		}
	};
}
// src/tools.js
var PRESET_NAMES = Object.freeze([
	"wave",
	"circle",
	"box",
	"underline",
	"highlight",
	"check",
	"arrow",
	"spiral"
]);
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sanitizeStrokePatch(rawPatch, existingProps = STROKE_DEFAULTS) {
	if (!isPlainObject(rawPatch)) throw new Error("INVALID_INPUT: patch must be a JSON object");
	const clean = {};
	if (rawPatch.preset !== void 0) {
		if (typeof rawPatch.preset !== "string" || !PRESET_NAMES.includes(rawPatch.preset)) throw new Error(`INVALID_INPUT: preset must be one of ${PRESET_NAMES.join(", ")}`);
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
	if (rawPatch.points !== void 0) {
		if (!Array.isArray(rawPatch.points) || rawPatch.points.length === 0 || rawPatch.points.length > 8192) throw new Error("INVALID_INPUT: points must be a non-empty array of {x, y, z?} objects (max 8192)");
		const validated = [];
		for (let i = 0; i < rawPatch.points.length; i++) {
			const pt = rawPatch.points[i];
			if (!isPlainObject(pt) || !Number.isFinite(Number(pt.x)) || !Number.isFinite(Number(pt.y))) throw new Error(`INVALID_INPUT: points[${i}] requires finite x and y numbers`);
			validated.push({
				x: round2(Number(pt.x)),
				y: round2(Number(pt.y)),
				z: round3(clamp(finiteOr(Number(pt.z), .5), .01, 1)),
				...pt.seg === 1 || pt.segment === "straight" ? { seg: 1 } : {}
			});
		}
		const normalized = normalizeStrokeGeometry(validated, { simplifyTolerance: finiteOr(Number(rawPatch.simplifyTolerance), 0) });
		clean.points = normalized.points;
		clean.segments = normalized.segments;
		clean.baseWidth = normalized.baseWidth;
		clean.baseHeight = normalized.baseHeight;
	}
	if (rawPatch.brush !== void 0) {
		if (!BRUSH_TYPES.includes(rawPatch.brush)) throw new Error(`INVALID_INPUT: brush must be one of ${BRUSH_TYPES.join(", ")}`);
		clean.brush = rawPatch.brush;
	}
	if (rawPatch.dash !== void 0) {
		if (!DASH_TYPES.includes(rawPatch.dash)) throw new Error(`INVALID_INPUT: dash must be one of ${DASH_TYPES.join(", ")}`);
		clean.dash = rawPatch.dash;
	}
	if (rawPatch.stroke !== void 0) {
		if (!isValidHexColor(rawPatch.stroke)) throw new Error("INVALID_INPUT: stroke must be a #rrggbb hex color");
		clean.stroke = rawPatch.stroke.trim();
	}
	if (rawPatch.fill !== void 0) {
		if (rawPatch.fill !== "none" && rawPatch.fill !== "transparent" && !isValidHexColor(rawPatch.fill)) throw new Error("INVALID_INPUT: fill must be \"none\", \"transparent\", or a #rrggbb hex color");
		clean.fill = rawPatch.fill.trim();
	}
	for (const [key, min, max] of [
		[
			"strokeWidth",
			1,
			64
		],
		[
			"thinning",
			0,
			.95
		],
		[
			"streamline",
			0,
			.95
		],
		[
			"smoothing",
			0,
			1
		],
		[
			"taperStart",
			0,
			120
		],
		[
			"taperEnd",
			0,
			120
		],
		[
			"fillOpacity",
			0,
			1
		],
		[
			"opacity",
			.05,
			1
		]
	]) if (rawPatch[key] !== void 0) {
		const num = Number(rawPatch[key]);
		if (!Number.isFinite(num) || num < min || num > max) throw new Error(`INVALID_INPUT: ${key} must be a number between ${min} and ${max}`);
		clean[key] = round3(num);
	}
	for (const boolKey of ["isClosed", "isPen"]) if (rawPatch[boolKey] !== void 0) {
		if (typeof rawPatch[boolKey] !== "boolean") throw new Error(`INVALID_INPUT: ${boolKey} must be a boolean`);
		clean[boolKey] = rawPatch[boolKey];
	}
	if (clean.baseWidth === void 0 && existingProps?.baseWidth) clean.baseWidth = existingProps.baseWidth;
	if (clean.baseHeight === void 0 && existingProps?.baseHeight) clean.baseHeight = existingProps.baseHeight;
	return clean;
}
/**
* Plans a batch of freehand stroke operations into `CanonicalPatchOp[]` without mutating the world.
*/
function planFreehandChanges(world, actions) {
	if (!Array.isArray(actions) || actions.length === 0 || actions.length > 50) throw new Error("INVALID_INPUT: actions must be a non-empty array of at most 50 items");
	const snapshot = world.exportCanonicalSnapshot?.() ?? {};
	const aliases = /* @__PURE__ */ new Map();
	const ops = [];
	for (const action of actions) {
		if (!isPlainObject(action)) throw new Error("INVALID_INPUT: each action must be an object");
		if (action.action === "create") {
			if (action.id !== void 0) {
				if (typeof action.id !== "string" || !action.id.trim() || aliases.has(action.id) || Object.hasOwn(snapshot, action.id)) throw new Error("INVALID_INPUT: duplicate or invalid create alias");
			}
			const generatedId = `freehand-${crypto.randomUUID()}`;
			aliases.set(action.id ?? generatedId, generatedId);
		}
	}
	let createSeq = 0;
	const createdIds = [...aliases.values()];
	const resolveId = (rawId) => aliases.get(rawId) ?? rawId;
	for (const action of actions) {
		const kind = action.action;
		if (![
			"create",
			"update",
			"move",
			"delete"
		].includes(kind)) throw new Error(`INVALID_INPUT: unsupported action "${String(kind)}"`);
		const id = kind === "create" ? createdIds[createSeq++] : resolveId(action.id);
		if (typeof id !== "string" || !id) throw new Error("INVALID_INPUT: missing target entity id");
		if (kind !== "create") {
			const alive = world.isAlive ? world.isAlive(id) : Boolean(snapshot[id]);
			const hasStroke = Boolean(world.getCanonical?.(id, STROKE_ASPECT_ID) ?? snapshot[id]?.[STROKE_ASPECT_ID]);
			if (!alive || !hasStroke) throw new Error(`INVALID_INPUT: freehand stroke entity "${id}" does not exist`);
		}
		if (kind === "delete") {
			ops.push({
				id,
				aspect: STROKE_ASPECT_ID,
				patch: null
			});
			continue;
		}
		if (kind === "move") {
			if (action.x !== void 0 || action.y !== void 0) {
				const currentTransform = world.getCanonical?.(id, "core.transform") ?? {
					x: 0,
					y: 0,
					rotation: 0
				};
				const x = action.x !== void 0 ? Number(action.x) : currentTransform.x;
				const y = action.y !== void 0 ? Number(action.y) : currentTransform.y;
				if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) throw new Error("INVALID_INPUT: invalid x/y coordinates");
				ops.push({
					id,
					aspect: "core.transform",
					patch: {
						x: round2(x),
						y: round2(y)
					}
				});
			}
			if (action.width !== void 0 || action.height !== void 0) {
				const currentBounds = world.getCanonical?.(id, "core.bounds") ?? {
					width: 180,
					height: 96
				};
				const width = action.width !== void 0 ? Number(action.width) : currentBounds.width;
				const height = action.height !== void 0 ? Number(action.height) : currentBounds.height;
				if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 8e3 || height > 8e3) throw new Error("INVALID_INPUT: invalid width/height bounds");
				ops.push({
					id,
					aspect: "core.bounds",
					patch: {
						width: round2(width),
						height: round2(height)
					}
				});
			}
			continue;
		}
		const existing = kind === "update" ? world.getCanonical?.(id, STROKE_ASPECT_ID) ?? STROKE_DEFAULTS : STROKE_DEFAULTS;
		const sanitized = sanitizeStrokePatch(action.patch ?? {}, existing);
		const merged = {
			...kind === "create" ? STROKE_DEFAULTS : existing,
			...sanitized
		};
		if (kind === "create") {
			const x = action.x !== void 0 ? Number(action.x) : 120;
			const y = action.y !== void 0 ? Number(action.y) : 120;
			const width = action.width !== void 0 ? Number(action.width) : merged.baseWidth ?? 180;
			const height = action.height !== void 0 ? Number(action.height) : merged.baseHeight ?? 96;
			if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) throw new Error("INVALID_INPUT: invalid create x/y coordinates");
			if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error("INVALID_INPUT: invalid create width/height bounds");
			ops.push({
				id,
				aspect: "core.transform",
				patch: {
					x: round2(x),
					y: round2(y),
					rotation: 0
				}
			});
			ops.push({
				id,
				aspect: "core.bounds",
				patch: {
					width: round2(width),
					height: round2(height)
				}
			});
			ops.push({
				id,
				aspect: STROKE_ASPECT_ID,
				patch: merged
			});
		} else ops.push({
			id,
			aspect: STROKE_ASPECT_ID,
			patch: sanitized
		});
	}
	if (ops.length > 150) throw new Error("INVALID_INPUT: operation budget exceeded");
	return ops;
}
/**
* Registers `drawing.freehand` read & proposal tools with the host `workspace.tools` service.
*/
function registerFreehandTools(context) {
	const tools = context?.services?.get?.("workspace.tools");
	if (!tools) return () => {};
	const { world } = context;
	const disposers = [];
	const registerTool = (name, description, properties, required, execute) => {
		disposers.push(tools.register({
			id: `${EXTENSION_ID}:${name}`,
			description,
			inputSchema: {
				type: "object",
				properties,
				required
			},
			execute: async (input, meta) => {
				meta?.signal?.throwIfAborted?.();
				return execute(input ?? {});
			}
		}));
	};
	try {
		if (typeof tools.registerDescriptor === "function") disposers.push(tools.registerDescriptor({
			aspect: STROKE_ASPECT_ID,
			description: "고성능 필압·속도 감응 자유 드로잉 스트로크 도형. 생성·수정·이동·삭제는 plan-changes 도구를 통해 사용자 승인 제안(prepareChange)으로 수행하세요.",
			fields: {
				brush: `Allowed: ${BRUSH_TYPES.join(", ")}`,
				dash: `Allowed: ${DASH_TYPES.join(", ")}`,
				stroke: "string (#rrggbb): 잉크 색상",
				strokeWidth: "number (1–64): 브러시 굵기",
				thinning: "number (0–0.95): 필압/속도 기반 가변 굵기 민감도 (0이면 일정한 굵기)",
				streamline: "number (0–0.95): 스트림라인 손떨림 보정 강도",
				smoothing: "number (0–1): 외곽선 폴리곤 보간 강도",
				taperStart: "number (0–120): 시작 끝단 테이퍼 길이",
				taperEnd: "number (0–120): 종료 끝단 테이퍼 길이",
				fill: "string (\"none\" | \"#rrggbb\"): 닫힌 스트로크 채우기 색상",
				fillOpacity: "number (0–1): 채우기 불투명도",
				opacity: "number (0.05–1): 스트로크 전체 불투명도",
				isClosed: "boolean: 시작점과 끝점을 닫힌 루프로 연결할지 여부",
				points: "array of {x, y, z}: 정규화된 로컬 스트로크 좌표 배열"
			}
		}));
		registerTool("presets", "자유 드로잉 브러시 모드, 선 스타일, 프리셋 스트로크 목록 조회 (읽기 전용).", {}, [], () => ({
			brushes: BRUSH_TYPES.map((id) => ({
				id,
				description: id === "pen" ? "필압·속도 감응 가변 굵기 펜" : id === "fine" ? "일정한 굵기의 정밀 모노라인 펜" : id === "marker" ? "강한 굵기 대비의 캘리그래피 마커" : "반투명 형광펜 브러시"
			})),
			dashes: DASH_TYPES,
			presets: PRESET_NAMES
		}));
		registerTool("search", "현재 캔버스의 자유 드로잉 스트로크 엔티티 목록과 브러시·포인트 요약 조회 (읽기 전용).", { brush: { type: "string" } }, [], ({ brush = "" }) => {
			const filterBrush = String(brush ?? "").trim();
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
					transform: world.getCanonical?.(id, "core.transform"),
					bounds: world.getCanonical?.(id, "core.bounds")
				});
			}
			return {
				total: entities.length,
				entities
			};
		});
		registerTool("plan-changes", "자유 드로잉 스트로크 생성·수정·이동·삭제 승인 제안 생성. actions는 JSON 배열 문자열입니다: [{\"action\":\"create\",\"id\":\"s1\",\"x\":120,\"y\":120,\"patch\":{\"preset\":\"wave\",\"brush\":\"pen\",\"stroke\":\"#3182f6\",\"strokeWidth\":8}},{\"action\":\"update\",\"id\":\"existing-id\",\"patch\":{\"brush\":\"highlighter\",\"stroke\":\"#f59e0b\"}},{\"action\":\"move\",\"id\":\"existing-id\",\"x\":200,\"y\":180,\"width\":240,\"height\":120},{\"action\":\"delete\",\"id\":\"existing-id\"}]. 직접 적용하지 않고 사용자 승인 제안을 반환합니다.", { actions: { type: "string" } }, ["actions"], ({ actions }) => {
			if (typeof tools.prepareChange !== "function") throw new Error("Host update required: workspace.tools.prepareChange is unavailable");
			let parsedActions;
			try {
				parsedActions = JSON.parse(actions);
			} catch (error) {
				throw new Error(`INVALID_INPUT: actions must be valid JSON (${error instanceof Error ? error.message : String(error)})`);
			}
			const ops = planFreehandChanges(world, parsedActions);
			return tools.prepareChange(ops);
		});
	} catch (error) {
		for (const dispose of disposers.reverse()) try {
			dispose();
		} catch {}
		throw error;
	}
	return () => {
		for (const dispose of disposers.splice(0).reverse()) try {
			dispose();
		} catch {}
	};
}
// src/index.js
var FREEHAND_ICON = Object.freeze({ paths: Object.freeze([
	"m4 13.5 8.5-8.5 3 3-8.5 8.5L3 17.5z",
	"m10.5 7 3 3",
	"M11.5 17c1.6 0 2.2-1.2 3.6-1.2 1 0 1.6.5 2.4 1.2"
]) });
var SIMPLIFY_ICON = Object.freeze({ paths: Object.freeze(["M3 15c3-8 5-8 8 0s5 8 6-10", "M3 15h2m11-10h2"]) });
var COMMAND_META = Object.freeze({
	"draw-tool": {
		title: "자유 드로잉 도구",
		summary: "필압·속도 감응 브러시로 캔버스에 자유곡선을 그립니다 (단축키 D).",
		keys: ["d"]
	},
	"insert-stroke": {
		title: "자유 드로잉 스트로크 추가",
		summary: "캔버스에 자유 드로잉 스트로크 엔티티를 즉시 추가합니다."
	},
	"simplify-stroke": {
		title: "스트로크 포인트 경량화 (RDP)",
		summary: "선택된 스트로크의 포인트를 Ramer-Douglas-Peucker 알고리즘으로 경량화합니다."
	},
	"smooth-stroke": {
		title: "스트로크 곡선 다듬기",
		summary: "선택된 스트로크의 손떨림 보정(Streamline)과 스무딩을 강화합니다."
	},
	"toggle-close-stroke": {
		title: "스트로크 닫힌 도형 전환",
		summary: "선택된 스트로크의 시작점과 끝점을 연결하거나 해제합니다."
	},
	"cycle-brush": {
		title: "브러시 종류 순환",
		summary: "선택된 스트로크의 브러시 종류(펜/모노라인/마커/형광펜)를 전환합니다."
	}
});
var strokeSelectionContribution = createStrokeSelectionContribution();
var freehandStrokeAspect = Object.freeze({
	id: STROKE_ASPECT_ID,
	label: "자유 드로잉",
	summary: extension_default.summary,
	layout: true,
	paintOverflow: 32,
	selection: strokeSelectionContribution,
	paintBounds: (derived) => derived?.inkBounds ?? {
		x: finiteOr(derived?.x, 0),
		y: finiteOr(derived?.y, 0),
		width: Math.max(1, finiteOr(derived?.width, 180)),
		height: Math.max(1, finiteOr(derived?.height, 96))
	},
	dependsOnCanonical: [
		"core.transform",
		"core.bounds",
		STROKE_ASPECT_ID
	],
	dependsOnComputed: [],
	defaults: STROKE_DEFAULTS,
	derive: deriveStrokeGeometry,
	renderMode: "vector",
	renderDom: renderStrokeDom,
	renderSvg: renderStrokeSvg,
	ui: { controls: [
		{
			id: "drawing.freehand.brush.selection",
			kind: "segmented",
			field: "brush",
			label: "브러시",
			placement: "selection-bar",
			options: [
				{
					label: "펜",
					value: "pen"
				},
				{
					label: "모노라인",
					value: "fine"
				},
				{
					label: "마커",
					value: "marker"
				},
				{
					label: "형광펜",
					value: "highlighter"
				}
			]
		},
		{
			id: "drawing.freehand.dash.selection",
			kind: "segmented",
			field: "dash",
			label: "선 스타일",
			placement: "selection-bar",
			options: [
				{
					label: "실선",
					value: "solid"
				},
				{
					label: "파선",
					value: "dashed"
				},
				{
					label: "점선",
					value: "dotted"
				}
			]
		},
		{
			id: "drawing.freehand.color.selection",
			kind: "segmented",
			field: "stroke",
			label: "잉크 색상",
			placement: "selection-bar",
			options: [
				{
					label: "블랙",
					value: "#17181c",
					swatch: "#17181c"
				},
				{
					label: "블루",
					value: "#3182f6",
					swatch: "#3182f6"
				},
				{
					label: "레드",
					value: "#ef4444",
					swatch: "#ef4444"
				},
				{
					label: "그린",
					value: "#10b981",
					swatch: "#10b981"
				},
				{
					label: "앰버",
					value: "#f59e0b",
					swatch: "#f59e0b"
				},
				{
					label: "퍼플",
					value: "#8b5cf6",
					swatch: "#8b5cf6"
				}
			]
		},
		{
			id: "drawing.freehand.simplify.selection",
			kind: "action",
			label: "포인트 경량화",
			icon: SIMPLIFY_ICON,
			commandSymbol: `${EXTENSION_ID}:simplify-stroke`,
			placement: "selection-bar",
			requiresSelection: true
		},
		{
			id: "drawing.freehand.brush.inspector",
			kind: "segmented",
			field: "brush",
			label: "브러시 종류",
			section: "브러시 및 잉크",
			placement: "inspector",
			options: [
				{
					label: "필압 펜",
					value: "pen"
				},
				{
					label: "모노라인",
					value: "fine"
				},
				{
					label: "마커",
					value: "marker"
				},
				{
					label: "형광펜",
					value: "highlighter"
				}
			]
		},
		{
			id: "drawing.freehand.stroke.inspector",
			kind: "color",
			field: "stroke",
			label: "잉크 색상",
			section: "브러시 및 잉크",
			placement: "inspector"
		},
		{
			id: "drawing.freehand.stroke.swatches",
			kind: "segmented",
			field: "stroke",
			label: "잉크 팔레트",
			section: "브러시 및 잉크",
			placement: "inspector",
			options: [
				{
					label: "차콜",
					value: "#17181c",
					swatch: "#17181c"
				},
				{
					label: "블루",
					value: "#3182f6",
					swatch: "#3182f6"
				},
				{
					label: "레드",
					value: "#ef4444",
					swatch: "#ef4444"
				},
				{
					label: "에메랄드",
					value: "#10b981",
					swatch: "#10b981"
				},
				{
					label: "앰버",
					value: "#f59e0b",
					swatch: "#f59e0b"
				},
				{
					label: "바이올렛",
					value: "#8b5cf6",
					swatch: "#8b5cf6"
				},
				{
					label: "핑크",
					value: "#ec4899",
					swatch: "#ec4899"
				}
			]
		},
		{
			id: "drawing.freehand.strokeWidth.inspector",
			kind: "slider",
			field: "strokeWidth",
			label: "브러시 굵기",
			section: "브러시 및 잉크",
			placement: "inspector",
			min: 1,
			max: 64,
			step: 1
		},
		{
			id: "drawing.freehand.dash.inspector",
			kind: "segmented",
			field: "dash",
			label: "선 종류",
			section: "브러시 및 잉크",
			placement: "inspector",
			options: [
				{
					label: "실선",
					value: "solid"
				},
				{
					label: "파선",
					value: "dashed"
				},
				{
					label: "점선",
					value: "dotted"
				}
			]
		},
		{
			id: "drawing.freehand.opacity.inspector",
			kind: "slider",
			field: "opacity",
			label: "불투명도",
			section: "브러시 및 잉크",
			placement: "inspector",
			min: .05,
			max: 1,
			step: .05
		},
		{
			id: "drawing.freehand.thinning.inspector",
			kind: "slider",
			field: "thinning",
			label: "필압·속도 굵기 변화 (Thinning)",
			section: "스트로크 다이나믹스",
			placement: "inspector",
			min: 0,
			max: .95,
			step: .05
		},
		{
			id: "drawing.freehand.streamline.inspector",
			kind: "slider",
			field: "streamline",
			label: "손떨림 보정 (Streamline)",
			section: "스트로크 다이나믹스",
			placement: "inspector",
			min: 0,
			max: .95,
			step: .05
		},
		{
			id: "drawing.freehand.smoothing.inspector",
			kind: "slider",
			field: "smoothing",
			label: "외곽선 스무딩 (Smoothing)",
			section: "스트로크 다이나믹스",
			placement: "inspector",
			min: 0,
			max: 1,
			step: .05
		},
		{
			id: "drawing.freehand.taperStart.inspector",
			kind: "slider",
			field: "taperStart",
			label: "시작 끝단 테이퍼",
			section: "스트로크 다이나믹스",
			placement: "inspector",
			min: 0,
			max: 120,
			step: 2
		},
		{
			id: "drawing.freehand.taperEnd.inspector",
			kind: "slider",
			field: "taperEnd",
			label: "종료 끝단 테이퍼",
			section: "스트로크 다이나믹스",
			placement: "inspector",
			min: 0,
			max: 120,
			step: 2
		},
		{
			id: "drawing.freehand.closed.inspector",
			kind: "toggle",
			field: "isClosed",
			label: "닫힌 도형 루프",
			section: "채우기 및 마감",
			placement: "inspector"
		},
		{
			id: "drawing.freehand.fill.inspector",
			kind: "segmented",
			field: "fill",
			label: "채우기 색상",
			section: "채우기 및 마감",
			placement: "inspector",
			options: [
				{
					label: "없음",
					value: "none"
				},
				{
					label: "블루",
					value: "#3182f6",
					swatch: "#3182f6"
				},
				{
					label: "그린",
					value: "#10b981",
					swatch: "#10b981"
				},
				{
					label: "앰버",
					value: "#f59e0b",
					swatch: "#f59e0b"
				},
				{
					label: "레드",
					value: "#ef4444",
					swatch: "#ef4444"
				},
				{
					label: "퍼플",
					value: "#8b5cf6",
					swatch: "#8b5cf6"
				}
			]
		},
		{
			id: "drawing.freehand.fillOpacity.inspector",
			kind: "slider",
			field: "fillOpacity",
			label: "채우기 불투명도",
			section: "채우기 및 마감",
			placement: "inspector",
			min: 0,
			max: 1,
			step: .05
		},
		{
			id: "drawing.freehand.simplify.inspector",
			kind: "action",
			label: "포인트 경량화 (RDP 최적화)",
			icon: SIMPLIFY_ICON,
			commandSymbol: `${EXTENSION_ID}:simplify-stroke`,
			section: "스트로크 최적화",
			placement: "inspector",
			requiresSelection: true
		},
		{
			id: "drawing.freehand.smooth.inspector",
			kind: "action",
			label: "곡선 다듬기 (Streamline 강화)",
			icon: FREEHAND_ICON,
			commandSymbol: `${EXTENSION_ID}:smooth-stroke`,
			section: "스트로크 최적화",
			placement: "inspector",
			requiresSelection: true
		}
	] }
});
function safeGetService(context, serviceId) {
	try {
		return context?.services?.get?.(serviceId);
	} catch {
		return;
	}
}
function getSelectionService(context) {
	try {
		const fromApi = context?.getExtensionApi?.("core.select-suite");
		if (fromApi) return fromApi;
	} catch {}
	return safeGetService(context, "canvas.selection");
}
function getActiveSurface(context) {
	return safeGetService(context, "canvas.active-tool-surface")?.get?.() ?? null;
}
function getSelectedStrokeIds(context, explicitEntityId) {
	if (typeof explicitEntityId === "string" && explicitEntityId) return context?.world?.getCanonical?.(explicitEntityId, STROKE_ASPECT_ID) ? [explicitEntityId] : [];
	return ((getActiveSurface(context)?.selection ?? getSelectionService(context))?.getSelection?.() ?? []).filter((id) => Boolean(context?.world?.getCanonical?.(id, STROKE_ASPECT_ID)));
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
/**
* Canonical state is only writable through one validated transaction per user
* intent; there is no per-aspect setter on the world. Read-only entities are
* skipped so a paused or foreign document never rejects the whole batch.
*/
function applyStrokePatches(context, ids, buildPatch) {
	const world = context?.world;
	if (!world || typeof world.applyCanonicalTransaction !== "function") return [];
	const ops = [];
	for (const id of ids) {
		const props = world.getCanonical(id, STROKE_ASPECT_ID);
		if (!props) continue;
		if (typeof world.isEntityReadOnly === "function" && world.isEntityReadOnly(id)) continue;
		const patch = buildPatch(props, id);
		if (patch) ops.push({
			id,
			aspect: STROKE_ASPECT_ID,
			patch
		});
	}
	if (!ops.length) return [];
	withHistoryGroup(context, () => world.applyCanonicalTransaction(`${EXTENSION_ID}:update`, ops, "local:user"));
	return ops.map((op) => op.id);
}
function readPreference(context, key, fallback) {
	try {
		const val = safeGetService(context, "extensions.preferences")?.get?.(key);
		return val !== void 0 ? val : fallback;
	} catch {
		return fallback;
	}
}
function writePreference(context, key, value) {
	try {
		safeGetService(context, "extensions.preferences")?.set?.(key, value);
	} catch {}
}
var src_default = {
	...createPackageManifest(extension_default),
	summary: extension_default.summary,
	aspects: [freehandStrokeAspect],
	ui: { controls: [{
		id: "drawing.freehand.tool.shelf",
		kind: "action",
		label: "자유 드로잉",
		mnemonic: "d",
		icon: FREEHAND_ICON,
		commandSymbol: `${EXTENSION_ID}:draw-tool`,
		placement: "tool-shelf",
		requiresSelection: false,
		activeToolState: FREEHAND_TOOL_STATE
	}] },
	activate(context) {
		const creation = safeGetService(context, "canvas.creation");
		if (!creation) throw new Error("자유 드로잉 확장에는 canvas.creation 호스트 서비스가 필요합니다.");
		let active = true;
		const ensureActive = () => {
			if (!active) throw new Error("자유 드로잉 확장이 비활성화되었습니다. 공개 API를 다시 조회하세요.");
		};
		const disposers = [];
		const selectionService = getSelectionService(context);
		if (typeof selectionService?.registerContribution === "function") disposers.push(selectionService.registerContribution(createStrokeSelectionContribution()));
		const gpuContributions = safeGetService(context, "canvas.gpu-contributions");
		if (typeof gpuContributions?.register === "function") disposers.push(gpuContributions.register(createStrokeGpuContribution()));
		const frames = safeGetService(context, "canvas.frames");
		const toolInput = safeGetService(context, "canvas.tool-input");
		const activeSurface = safeGetService(context, "canvas.active-tool-surface");
		const resolveToolEndpoints = () => {
			const active = activeSurface?.get?.() ?? null;
			const rawSurface = active?.surface ?? safeGetService(context, "canvas.surface") ?? null;
			return {
				surface: rawSurface?.element ?? rawSurface ?? null,
				hud: active?.hud ?? rawSurface?.hud ?? null,
				host: active?.host ?? safeGetService(context, "canvas.interaction") ?? null,
				selection: active?.selection ?? getSelectionService(context) ?? null
			};
		};
		let currentTool = null;
		let boundEndpoints = null;
		let disposeSurfaceTool = () => {};
		const syncSurfaceTool = (explicitTarget) => {
			const next = explicitTarget && typeof explicitTarget === "object" && ("surface" in explicitTarget || "selection" in explicitTarget) ? {
				surface: explicitTarget.surface?.element ?? explicitTarget.surface ?? null,
				hud: explicitTarget.hud ?? explicitTarget.surface?.hud ?? null,
				host: explicitTarget.host ?? safeGetService(context, "canvas.interaction") ?? null,
				selection: explicitTarget.selection ?? getSelectionService(context) ?? null
			} : resolveToolEndpoints();
			if (currentTool && boundEndpoints && boundEndpoints.surface === next.surface && boundEndpoints.hud === next.hud && boundEndpoints.host === next.host && boundEndpoints.selection === next.selection) return currentTool;
			const wasActive = Boolean(currentTool?.active) || getMachineStateId(boundEndpoints?.selection?.stateMachine) === FREEHAND_TOOL_STATE;
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
				setPreference: (key, value) => writePreference(context, key, value)
			});
			const unmountEvents = tool.mount();
			const unmountState = next.selection?.stateMachine?.mountChildState?.("root.select", tool.createStateNode()) ?? (() => {});
			const offFrames = frames?.subscribe?.(() => tool.flushFrame()) ?? (() => {});
			currentTool = tool;
			boundEndpoints = next;
			disposeSurfaceTool = () => {
				if (getMachineStateId(next.selection?.stateMachine) === FREEHAND_TOOL_STATE) transitionMachineToIdle(next.selection.stateMachine);
				offFrames();
				unmountState();
				unmountEvents();
				tool.dispose();
				currentTool = null;
				boundEndpoints = null;
			};
			if (wasActive) tool.enter();
			return tool;
		};
		syncSurfaceTool();
		if (typeof activeSurface?.subscribe === "function") {
			const offSub = activeSurface.subscribe((next) => syncSurfaceTool(next));
			disposers.push(() => {
				offSub();
				disposeSurfaceTool();
			});
		} else disposers.push(() => disposeSurfaceTool());
		if (typeof toolInput?.register === "function") {
			const handler = {
				handleKeyDown: (event) => currentTool?.onKeyDown?.(event) ?? false,
				onEscape: () => {
					const machine = (getActiveSurface(context)?.selection ?? selectionService)?.stateMachine;
					if (getMachineStateId(machine) !== FREEHAND_TOOL_STATE) return false;
					return machine.dispatch({ type: "escape" });
				},
				onBlur: () => {
					currentTool?.onWindowBlur?.();
				}
			};
			const offToolInput = toolInput.register.length >= 2 ? toolInput.register(EXTENSION_ID, handler) : toolInput.register(EXTENSION_ID, handler) ?? toolInput.register(handler);
			if (typeof offToolInput === "function") disposers.push(offToolInput);
		}
		const insertStroke = (options = {}) => {
			ensureActive();
			const presetData = options.preset ? createPresetStroke(options.preset) : null;
			const defaultBrush = normalizeBrush(options.brush ?? readPreference(context, "defaultBrush", STROKE_DEFAULTS.brush), STROKE_DEFAULTS.brush);
			const defaultStroke = sanitizeColor(options.stroke ?? readPreference(context, "defaultStroke", STROKE_DEFAULTS.stroke), STROKE_DEFAULTS.stroke);
			const defaultWidth = clamp(finiteOr(Number(options.strokeWidth ?? readPreference(context, "defaultStrokeWidth", STROKE_DEFAULTS.strokeWidth)), STROKE_DEFAULTS.strokeWidth), 1, 64);
			const defaultStreamline = clamp(finiteOr(Number(options.streamline ?? readPreference(context, "defaultStreamline", STROKE_DEFAULTS.streamline)), STROKE_DEFAULTS.streamline), 0, .95);
			let normalized = null;
			if (Array.isArray(options.points) && options.points.length > 0) normalized = normalizeStrokeGeometry(options.points, { simplifyTolerance: finiteOr(Number(options.simplifyTolerance), 0) });
			const baseWidth = normalized?.baseWidth ?? presetData?.baseWidth ?? 180;
			const baseHeight = normalized?.baseHeight ?? presetData?.baseHeight ?? 96;
			const props = {
				...STROKE_DEFAULTS,
				...presetData ?? {},
				brush: presetData?.brush && !options.brush ? presetData.brush : defaultBrush,
				stroke: presetData?.stroke && !options.stroke ? presetData.stroke : defaultStroke,
				strokeWidth: presetData?.strokeWidth && !options.strokeWidth ? presetData.strokeWidth : defaultWidth,
				streamline: defaultStreamline,
				dash: normalizeDash(options.dash ?? STROKE_DEFAULTS.dash),
				thinning: clamp(finiteOr(Number(options.thinning), STROKE_DEFAULTS.thinning), 0, .95),
				smoothing: clamp(finiteOr(Number(options.smoothing), STROKE_DEFAULTS.smoothing), 0, 1),
				taperStart: clamp(finiteOr(Number(options.taperStart), STROKE_DEFAULTS.taperStart), 0, 120),
				taperEnd: clamp(finiteOr(Number(options.taperEnd), STROKE_DEFAULTS.taperEnd), 0, 120),
				fill: sanitizeColor(options.fill ?? STROKE_DEFAULTS.fill, STROKE_DEFAULTS.fill),
				fillOpacity: clamp(finiteOr(Number(options.fillOpacity), STROKE_DEFAULTS.fillOpacity), 0, 1),
				opacity: clamp(finiteOr(Number(options.opacity), STROKE_DEFAULTS.opacity), .05, 1),
				isClosed: Boolean(options.isClosed ?? presetData?.isClosed ?? STROKE_DEFAULTS.isClosed),
				isPen: Boolean(options.isPen ?? STROKE_DEFAULTS.isPen),
				points: normalized?.points ?? presetData?.points ?? STROKE_DEFAULTS.points,
				segments: normalized?.segments ?? presetData?.segments ?? STROKE_DEFAULTS.segments,
				baseWidth,
				baseHeight
			};
			const width = Math.max(1, finiteOr(Number(options.width), normalized?.width ?? baseWidth));
			const height = Math.max(1, finiteOr(Number(options.height), normalized?.height ?? baseHeight));
			const createPayload = {
				caller: options.caller ?? `${EXTENSION_ID}:insert-stroke`,
				aspects: { [STROKE_ASPECT_ID]: props },
				width,
				height
			};
			if (Number.isFinite(options.x)) createPayload.x = Number(options.x);
			else if (normalized && Number.isFinite(normalized.x) && Array.isArray(options.points)) createPayload.x = normalized.x;
			if (Number.isFinite(options.y)) createPayload.y = Number(options.y);
			else if (normalized && Number.isFinite(normalized.y) && Array.isArray(options.points)) createPayload.y = normalized.y;
			const createdId = creation.create(createPayload);
			(getActiveSurface(context)?.selection ?? selectionService)?.select?.(createdId);
			return createdId;
		};
		const toggleDrawTool = () => {
			ensureActive();
			syncSurfaceTool();
			const endpoints = resolveToolEndpoints();
			const machine = endpoints.selection?.stateMachine;
			if (Boolean(currentTool?.active) || getMachineStateId(machine) === FREEHAND_TOOL_STATE) {
				if (currentTool) return currentTool.exit();
				return transitionMachineToIdle(machine);
			}
			if (context?.commands?.get?.("canvas:select-tool")) {
				context.commands.execute("canvas:select-tool");
				syncSurfaceTool();
			}
			if (currentTool) return currentTool.enter();
			if (machine && typeof machine.transition === "function") {
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
			const tolerance = clamp(finiteOr(Number(options.tolerance ?? readPreference(context, "simplifyTolerance", 1.2)), 1.2), .1, 12);
			return applyStrokePatches(context, ids, (props) => {
				if (!Array.isArray(props.points) || props.points.length <= 3) return null;
				return { points: simplifyStrokePoints(props.points, tolerance).map((p) => ({
					x: round2(p.x),
					y: round2(p.y),
					z: round3(p.z ?? .5)
				})) };
			});
		};
		const smoothSelectedStrokes = (options = {}) => {
			ensureActive();
			const ids = getSelectedStrokeIds(context, options.entityId);
			if (ids.length === 0) return [];
			return applyStrokePatches(context, ids, (props) => ({
				streamline: clamp(round2(finiteOr(Number(props.streamline), .5) + .15), 0, .95),
				smoothing: clamp(round2(finiteOr(Number(props.smoothing), .5) + .15), 0, 1)
			}));
		};
		const toggleCloseSelectedStrokes = (options = {}) => {
			ensureActive();
			const ids = getSelectedStrokeIds(context, options.entityId);
			if (ids.length === 0) return [];
			return applyStrokePatches(context, ids, (props) => ({ isClosed: options.isClosed !== void 0 ? Boolean(options.isClosed) : !props.isClosed }));
		};
		const cycleBrushOnSelectedStrokes = (options = {}) => {
			ensureActive();
			const ids = getSelectedStrokeIds(context, options.entityId);
			if (ids.length === 0) return [];
			return applyStrokePatches(context, ids, (props) => {
				const currentIdx = BRUSH_TYPES.indexOf(props.brush ?? "pen");
				return { brush: options.brush && BRUSH_TYPES.includes(options.brush) ? options.brush : BRUSH_TYPES[(currentIdx + 1) % BRUSH_TYPES.length] };
			});
		};
		const commandHandlers = {
			"draw-tool": toggleDrawTool,
			"insert-stroke": insertStroke,
			"simplify-stroke": simplifySelectedStrokes,
			"smooth-stroke": smoothSelectedStrokes,
			"toggle-close-stroke": toggleCloseSelectedStrokes,
			"cycle-brush": cycleBrushOnSelectedStrokes
		};
		for (const name of COMMAND_NAMES) {
			const meta = COMMAND_META[name];
			const offCmd = context.commands.register({
				id: `${EXTENSION_ID}:${name}`,
				title: meta.title,
				summary: meta.summary,
				shortcutScope: "canvas",
				...meta.keys ? { keys: meta.keys } : {},
				run: (args = {}) => commandHandlers[name](args)
			});
			disposers.push(offCmd);
		}
		disposers.push(registerFreehandTools(context));
		return {
			api: Object.freeze({
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
				}
			}),
			dispose() {
				if (!active) return;
				active = false;
				for (const off of disposers.splice(0).reverse()) try {
					off();
				} catch {}
			}
		};
	}
};
export { BRUSH_TYPES, COMMAND_NAMES, DASH_TYPES, EXTENSION_ID, EXTENSION_MANIFEST, FREEHAND_ICON, FREEHAND_TOOL_STATE, PRESET_NAMES, SIMPLIFY_ICON, STROKE_ASPECT_ID, STROKE_DEFAULTS, createPackageManifest, createPresetStroke, createStrokeGpuContribution, createStrokeSelectionContribution, src_default as default, deriveStrokeGeometry, escapeAttr, freehandStrokeAspect, getStrokeOutlinePoints, getStrokePoints, getSvgPathFromStrokePoints, normalizeStrokeGeometry, planFreehandChanges, registerFreehandTools, renderStrokeDom, renderStrokeSvg, resolveStrokeStyle, sanitizeStrokePatch, settingsSchema, simplifyStrokePoints };
