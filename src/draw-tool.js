import {
  MAX_STROKE_POINTS,
  STROKE_DEFAULTS,
  clamp,
  createDotSvgPath,
  finiteOr,
  getStrokeOutlinePoints,
  getStrokePoints,
  getStrokeRadius,
  getSvgPathFromStrokePoints,
  normalizeStrokeGeometry,
  resolveStrokeStyle,
  round2,
} from './freehand.js';
import { EXTENSION_ID, FREEHAND_TOOL_STATE, STROKE_ASPECT_ID } from './manifest.js';

const UI_SELECTOR =
  'input,textarea,select,button,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[data-canvas-ui],[data-text-editor]';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ANGLE_SNAP_RAD = Math.PI / 12; // 15° increments
export const SELECT_IDLE_STATE = 'root.select.core.select-suite:idle';
const LEGACY_SELECT_IDLE_STATE = 'root.select.idle';

export function getMachineStateId(stateMachine) {
  if (!stateMachine) return undefined;
  if (typeof stateMachine.stateId === 'string') return stateMachine.stateId;
  if (typeof stateMachine.getState === 'function') return stateMachine.getState();
  return undefined;
}

export function transitionMachineToIdle(stateMachine) {
  if (!stateMachine || typeof stateMachine.transition !== 'function') {
    return SELECT_IDLE_STATE;
  }
  try {
    const ok = stateMachine.transition(SELECT_IDLE_STATE);
    if (ok !== false && getMachineStateId(stateMachine) === SELECT_IDLE_STATE) {
      return SELECT_IDLE_STATE;
    }
  } catch {
    // Fallback for minimal test state machines
  }
  try {
    stateMachine.transition(LEGACY_SELECT_IDLE_STATE);
  } catch {
    // Ignore transition errors when parent state is unmounted
  }
  return getMachineStateId(stateMachine) ?? SELECT_IDLE_STATE;
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
export class FreeDrawTool {
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

    // Pre-allocated typed buffers for 0-GC pointermove ingestion
    this.rawX = new Float64Array(MAX_STROKE_POINTS);
    this.rawY = new Float64Array(MAX_STROKE_POINTS);
    this.rawZ = new Float64Array(MAX_STROKE_POINTS);
    this.rawSeg = new Uint8Array(MAX_STROKE_POINTS);
    this.rawCount = 0;

    // Pre-allocated mutable points for 0-GC host coordinate projection
    this.tmpPoint = { x: 0, y: 0 };
    this.tmpOrigin = { x: 0, y: 0 };

    // Cached surface rect updated on pointerdown / resize
    this.rectLeft = 0;
    this.rectTop = 0;

    // HUD SVG elements for live preview
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
    if (!hud || typeof hud.ownerDocument?.createElementNS !== 'function') return;
    if (this.hudSvg) return;

    const doc = hud.ownerDocument;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'alid-freehand-hud');
    svg.dataset.canvasUi = 'freehand-preview';
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;display:none';

    const group = doc.createElementNS(SVG_NS, 'g');
    const fillPath = doc.createElementNS(SVG_NS, 'path');
    fillPath.setAttribute('fill', 'none');
    fillPath.setAttribute('stroke', 'none');

    const inkPath = doc.createElementNS(SVG_NS, 'path');
    inkPath.setAttribute('fill', 'none');
    inkPath.setAttribute('stroke', 'none');

    const closeRing = doc.createElementNS(SVG_NS, 'circle');
    closeRing.setAttribute('fill', 'rgba(49, 130, 246, 0.14)');
    closeRing.setAttribute('stroke', '#3182f6');
    closeRing.setAttribute('stroke-width', '1.5');
    closeRing.style.display = 'none';

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
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return (
      this.composing
      || Boolean(event?.isComposing)
      || event?.keyCode === 229
      || event?.key === 'Process'
      || now - this.compositionEndedAt < 16
    );
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
      zoom: Math.max(0.01, finiteOr(cam?.zoom, 1)),
    };
  }

  getZoom() {
    const host = this.options?.host;
    if (typeof host?.getZoom === 'function') {
      return Math.max(0.01, finiteOr(host.getZoom(), 1));
    }
    return this.getCamera().zoom;
  }

  screenToWorldPoint(clientX, clientY, out) {
    const host = this.options?.host;
    if (typeof host?.screenToWorld === 'function') {
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
    if (typeof host?.worldToScreen === 'function') {
      const hudRect = this.hudElement?.getBoundingClientRect?.();
      const left = finiteOr(hudRect?.left, 0);
      const top = finiteOr(hudRect?.top, 0);
      host.worldToScreen(0, 0, this.tmpOrigin);
      // No rounding: the scale applies about world (0, 0), so any zoom error grows with the
      // stroke's world position and the preview drifts away from the committed stroke.
      const tx = finiteOr(this.tmpOrigin.x, 0) - left;
      const ty = finiteOr(this.tmpOrigin.y, 0) - top;
      this.hudWorldGroup.setAttribute('transform', `translate(${tx} ${ty}) scale(${zoom})`);
      return;
    }
    const cam = this.getCamera();
    this.hudWorldGroup.setAttribute('transform', `translate(${cam.x},${cam.y}) scale(${cam.zoom})`);
  }

  resolveActiveBrushProps() {
    const getPref = this.options?.getPreference;
    const base = {
      ...STROKE_DEFAULTS,
      brush: getPref?.('defaultBrush', STROKE_DEFAULTS.brush) ?? STROKE_DEFAULTS.brush,
      stroke: getPref?.('defaultStroke', STROKE_DEFAULTS.stroke) ?? STROKE_DEFAULTS.stroke,
      strokeWidth: Number(getPref?.('defaultStrokeWidth', STROKE_DEFAULTS.strokeWidth) ?? STROKE_DEFAULTS.strokeWidth),
      streamline: Number(getPref?.('defaultStreamline', STROKE_DEFAULTS.streamline) ?? STROKE_DEFAULTS.streamline),
    };

    // Inherit style from currently selected freehand stroke if one is selected
    const selectedIds = this.options?.selection?.getSelection?.() ?? [];
    if (selectedIds.length > 0) {
      const existing = this.options?.world?.getCanonical?.(selectedIds[0], STROKE_ASPECT_ID);
      if (existing && typeof existing === 'object') {
        return {
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
          opacity: existing.opacity ?? base.opacity,
        };
      }
    }
    return base;
  }

  enter() {
    this.options?.selection?.select?.(null);
    this.options?.selection?.clear?.();
    const machine = this.options?.selection?.stateMachine;
    if (machine && typeof machine.transition === 'function') {
      machine.transition(FREEHAND_TOOL_STATE);
    } else {
      this.active = true;
    }
    return FREEHAND_TOOL_STATE;
  }

  exit() {
    // onExit commits an in-progress stroke; only Escape discards it explicitly.
    return transitionMachineToIdle(this.options?.selection?.stateMachine);
  }

  toggle() {
    const machine = this.options?.selection?.stateMachine;
    if (this.active || getMachineStateId(machine) === FREEHAND_TOOL_STATE) {
      return this.exit();
    }
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
          if (surface.style) surface.style.cursor = 'crosshair';
        }
        this.syncHudVisibility();
        this.options?.host?.requestRender?.();
      },
      onExit: () => {
        // Leaving the tool mid-stroke (another tool, view switch) keeps the ink drawn so far.
        // The commit is deferred: creating an entity transitions the HSM, which must not
        // re-enter while this exit is still running.
        const pending = this.drawing ? this.takeDraft() : null;
        this.abortDraft();
        this.active = false;
        if (pending) queueMicrotask(() => this.commitDraft(pending, { reenter: false }));
        const surface = this.surfaceElement;
        if (surface) {
          if (surface.dataset?.activeTool === EXTENSION_ID) {
            delete surface.dataset.activeTool;
          }
          if (surface.style?.cursor === 'crosshair') {
            surface.style.cursor = '';
          }
        }
        this.syncHudVisibility();
        this.options?.host?.requestRender?.();
      },
      onEvent: event => {
        if (!event || typeof event.type !== 'string') return false;
        if (event.type === 'escape' || event.type === 'cancel') {
          if (this.drawing) {
            this.abortDraft();
            return true;
          }
          this.exit();
          return true;
        }
        if (event.type === 'enter' || event.type === 'complete') {
          if (this.drawing) {
            this.finishDraft();
            return true;
          }
          return false;
        }
        return false;
      },
    };
  }

  onPointerDown = event => {
    if (!this.active) return;
    if (this.drawing) {
      if (event.pointerId === this.pointerId) return;
      // A second finger starts a pinch: keep what was drawn so far (tldraw interrupt semantics).
      // Any other extra pointer is ignored so it never resets the live draft.
      if (event.pointerType === 'touch') this.finishDraft();
      return;
    }
    if (event.button !== 0) return;
    const surface = this.surfaceElement;
    // The document-level listener sees presses anywhere; only presses on this canvas draw.
    if (surface && event.target && typeof surface.contains === 'function' && event.target !== surface && !surface.contains(event.target)) return;
    if (this.options?.host?.isSelectionEnabled?.() === false) return;
    if (this.options?.host?.isPanGesture?.(event)) return;
    if (typeof event.target?.closest === 'function' && event.target.closest(UI_SELECTOR)) return;

    this.updateSurfaceRect();
    const pt = this.screenToWorldPoint(event.clientX, event.clientY, this.tmpPoint);
    const wx = pt.x;
    const wy = pt.y;
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;

    const isPenEvent =
      event.pointerType === 'pen' && typeof event.pressure === 'number' && event.pressure > 0;
    const pressure = isPenEvent ? clamp(event.pressure, 0.02, 1) : 0.5;

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
    } catch {
      // Ignore capture errors on synthetic pointer events
    }

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
  onPointerMove = event => {
    if (!this.active || !this.drawing) return;
    if (this.pointerId !== null && event.pointerId !== undefined && event.pointerId !== this.pointerId) {
      return;
    }

    event.preventDefault?.();
    event.stopImmediatePropagation?.();

    const zoom = this.getZoom();
    const minDist = Math.max(0.28, 1.2 / zoom);
    const minDistSq = minDist * minDist;
    const shiftHeld = Boolean(event.shiftKey);
    const snapAngle = Boolean(event.ctrlKey || event.metaKey);

    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null;
    const count = coalesced && coalesced.length > 0 ? coalesced.length : 1;

    for (let i = 0; i < count; i++) {
      const sample = coalesced && coalesced.length > 0 ? coalesced[i] : event;
      const pt = this.screenToWorldPoint(sample.clientX, sample.clientY, this.tmpPoint);
      let wx = pt.x;
      let wy = pt.y;
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;

      const isPenSample =
        (sample.pointerType === 'pen' || this.hasRealPressure)
        && typeof sample.pressure === 'number'
        && sample.pressure > 0;
      if (isPenSample) this.hasRealPressure = true;
      const wz = isPenSample ? clamp(sample.pressure, 0.02, 1) : 0.5;

      const lastIdx = this.rawCount - 1;
      if (shiftHeld) {
        // Straight-line segment mode (tldraw Shift behavior)
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
          if (this.rawCount < MAX_STROKE_POINTS) {
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

      if (this.straightSegmentActive) {
        this.straightSegmentActive = false;
      }

      const dx = wx - this.rawX[lastIdx];
      const dy = wy - this.rawY[lastIdx];
      const distSq = dx * dx + dy * dy;

      if (distSq < minDistSq) {
        if (isPenSample && Math.abs(wz - this.rawZ[lastIdx]) > 0.04) {
          this.rawZ[lastIdx] = wz;
          this.previewDirty = true;
        }
        continue;
      }

      if (this.rawCount < MAX_STROKE_POINTS) {
        this.rawX[this.rawCount] = wx;
        this.rawY[this.rawCount] = wy;
        this.rawZ[this.rawCount] = wz;
        this.rawSeg[this.rawCount] = 0;
        this.rawCount++;
        this.previewDirty = true;
      }
    }

    // Check loop auto-close when Alt is held or closed fill is configured
    if (this.rawCount >= 6) {
      const styleWidth = finiteOr(this.activeStyleProps?.strokeWidth, STROKE_DEFAULTS.strokeWidth);
      const closeThreshold = Math.max(10 / zoom, styleWidth * 1.6);
      const endX = this.rawX[this.rawCount - 1];
      const endY = this.rawY[this.rawCount - 1];
      const distToStart = Math.hypot(endX - this.rawX[0], endY - this.rawY[0]);
      this.willAutoClose = Boolean(event.altKey) && distToStart <= closeThreshold;
    } else {
      this.willAutoClose = false;
    }

    if (this.previewDirty) {
      this.options?.host?.requestRender?.();
    }
  };

  onPointerUp = event => {
    if (!this.active || !this.drawing) return;
    if (this.pointerId !== null && event.pointerId !== undefined && event.pointerId !== this.pointerId) {
      return;
    }
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    this.releaseCapture(event.pointerId);
    this.finishDraft();
  };

  // tldraw parity: an interrupted gesture (palm rejection, lost capture, window switch)
  // completes the stroke drawn so far instead of discarding it. Only Escape discards.
  onPointerCancel = event => {
    if (!this.drawing) return;
    if (this.pointerId !== null && event?.pointerId !== undefined && event.pointerId !== this.pointerId) return;
    this.releaseCapture(event?.pointerId ?? this.pointerId);
    this.finishDraft();
  };

  onLostPointerCapture = event => {
    if (!this.drawing) return;
    if (this.pointerId !== null && event?.pointerId !== undefined && event.pointerId !== this.pointerId) return;
    this.finishDraft();
  };

  onWindowBlur = () => {
    this.composing = false;
    if (this.drawing) {
      this.finishDraft();
    }
  };

  onKeyDown = event => {
    if (!this.active) return false;
    // The window listener and canvas.tool-input may both deliver the same key event.
    // Redelivery must report the first pass's verdict: claiming a key the first pass
    // declined would make the host preventDefault it and kill every other shortcut.
    if (event && this.lastKeyEvent === event) return this.lastKeyHandled === true;
    this.lastKeyEvent = event;
    const handled = this.handleKeyDownOnce(event);
    this.lastKeyHandled = handled;
    return handled;
  };

  handleKeyDownOnce = event => {
    if (this.isImeActive(event)) return false;
    if (typeof event.target?.closest === 'function' && event.target.closest(UI_SELECTOR)) return false;

    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (this.drawing) {
        this.abortDraft();
      } else {
        this.exit();
      }
      return true;
    }

    if (event.key === 'Enter' && this.drawing) {
      event.preventDefault?.();
      event.stopPropagation?.();
      this.finishDraft();
      return true;
    }

    if ((event.key === '[' || event.key === ']') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Quick brush size adjustment with [ and ]
      const delta = event.key === ']' ? 2 : -2;
      const current = finiteOr(
        this.options?.getPreference?.('defaultStrokeWidth', STROKE_DEFAULTS.strokeWidth),
        STROKE_DEFAULTS.strokeWidth,
      );
      const next = clamp(current + delta, 1, 64);
      this.options?.setPreference?.('defaultStrokeWidth', next);
      if (this.activeStyleProps) {
        this.activeStyleProps = { ...this.activeStyleProps, strokeWidth: next };
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
    this.compositionEndedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  };

  releaseCapture(pointerId) {
    if (pointerId === null || pointerId === undefined) return;
    try {
      const surface = this.surfaceElement;
      if (surface?.hasPointerCapture?.(pointerId)) {
        surface.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore synthetic pointer capture release errors
    }
  }

  resetDraft() {
    this.drawing = false;
    this.pointerId = null;
    this.hasRealPressure = false;
    this.straightSegmentActive = false;
    this.willAutoClose = false;
    this.rawCount = 0;
    this.previewDirty = false;
    if (this.hudFillPath) this.hudFillPath.setAttribute('d', '');
    if (this.hudInkPath) this.hudInkPath.setAttribute('d', '');
    if (this.hudCloseRing) this.hudCloseRing.style.display = 'none';
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
    for (let i = 0; i < this.rawCount; i++) {
      rawPoints[i] = {
        x: this.rawX[i],
        y: this.rawY[i],
        z: this.rawZ[i],
        seg: this.rawSeg[i],
      };
    }
    return {
      rawPoints,
      isPen: this.hasRealPressure,
      isClosed: Boolean(this.willAutoClose || this.activeStyleProps?.isClosed),
      baseProps: this.activeStyleProps ?? this.resolveActiveBrushProps(),
      zoom: this.getZoom(),
    };
  }

  commitDraft(draft, { reenter }) {
    if (!draft || draft.rawPoints.length === 0) return null;
    const { rawPoints, isPen, isClosed, baseProps, zoom } = draft;
    // tldraw parity: commit exactly the points the live preview drew. Simplifying here would
    // feed streamline/outline different input and visibly change the stroke on pointerup.
    // Point reduction stays available as the explicit simplify-stroke command.
    void zoom;
    const normalized = normalizeStrokeGeometry(rawPoints, { simplifyTolerance: 0 });
    const strokeProps = {
      ...STROKE_DEFAULTS,
      ...baseProps,
      points: normalized.points,
      segments: normalized.segments,
      baseWidth: normalized.baseWidth,
      baseHeight: normalized.baseHeight,
      isClosed,
      isPen,
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
        aspects: { [STROKE_ASPECT_ID]: strokeProps },
      });
    } catch (error) {
      // Never lose a stroke silently: surface the host's rejection.
      this.options?.host?.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (!this.options?.host?.onError) console.error('[drawing.freehand] stroke commit failed', error);
      if (reenter) this.enter();
      return null;
    }

    this.lastCreatedId = createdId;
    if (!reenter) {
      this.options?.host?.requestRender?.();
      return createdId;
    }

    const keepActive = this.options?.getPreference?.('keepToolActive', true) !== false;
    if (keepActive) {
      // Host createEntity() transitions back to select idle and selects the new entity.
      // Re-enter FREEHAND_TOOL_STATE and clear selection so users can draw continuous strokes.
      this.enter();
    } else {
      this.options?.selection?.select?.(createdId);
      this.exit();
    }

    this.options?.host?.requestRender?.();
    return createdId;
  }

  syncHudVisibility() {
    if (!this.hudSvg) return;
    this.hudSvg.style.display = this.active && this.drawing ? 'block' : 'none';
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
      ...(this.activeStyleProps ?? STROKE_DEFAULTS),
      isClosed: Boolean(this.willAutoClose || this.activeStyleProps?.isClosed),
      isPen: this.hasRealPressure,
    });

    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
      pts[i] = {
        x: this.rawX[i],
        y: this.rawY[i],
        z: this.rawZ[i],
        seg: this.rawSeg[i],
      };
    }

    const strokePoints = getStrokePoints(pts, {
      size: style.effectiveWidth,
      streamline: style.streamline,
      isClosed: style.isClosed,
    });

    const totalLen = strokePoints.length > 0 ? strokePoints[strokePoints.length - 1].runningLength : 0;
    const isDot = strokePoints.length <= 1 || totalLen <= Math.max(1.2, style.effectiveWidth * 0.2);

    if (style.fill !== 'none' && style.fill !== 'transparent' && style.fillOpacity > 0 && strokePoints.length >= 3) {
      const fillD = getSvgPathFromStrokePoints(strokePoints, true);
      this.hudFillPath.setAttribute('d', fillD);
      this.hudFillPath.setAttribute('fill', style.fill);
      this.hudFillPath.setAttribute('fill-opacity', String(round2(style.fillOpacity * style.effectiveOpacity)));
    } else {
      this.hudFillPath.setAttribute('d', '');
    }

    if (isDot) {
      const c = strokePoints[0] ?? pts[0];
      const r = getStrokeRadius(style.effectiveWidth, style.thinning * 0.5, style.isPen ? c.pressure : 0.65);
      this.hudInkPath.setAttribute('d', createDotSvgPath(c.x, c.y, r));
      this.hudInkPath.setAttribute('fill', style.stroke);
      this.hudInkPath.setAttribute('fill-opacity', String(style.effectiveOpacity));
      this.hudInkPath.setAttribute('stroke', 'none');
    } else if (style.useOutlinePolygon) {
      const outline = getStrokeOutlinePoints(strokePoints, {
        size: style.effectiveWidth,
        thinning: style.thinning,
        smoothing: style.smoothing,
        simulatePressure: !style.isPen,
        taperStart: style.taperStart,
        taperEnd: style.taperEnd,
        isClosed: style.isClosed,
      });
      this.hudInkPath.setAttribute('d', getSvgPathFromStrokePoints(outline, true));
      this.hudInkPath.setAttribute('fill', style.stroke);
      this.hudInkPath.setAttribute('fill-opacity', String(style.effectiveOpacity));
      this.hudInkPath.setAttribute('stroke', 'none');
    } else {
      this.hudInkPath.setAttribute('d', getSvgPathFromStrokePoints(strokePoints, style.isClosed));
      this.hudInkPath.setAttribute('fill', 'none');
      this.hudInkPath.setAttribute('stroke', style.stroke);
      this.hudInkPath.setAttribute('stroke-width', String(round2(style.effectiveWidth)));
      this.hudInkPath.setAttribute('stroke-opacity', String(style.effectiveOpacity));
      this.hudInkPath.setAttribute('stroke-linecap', 'round');
      this.hudInkPath.setAttribute('stroke-linejoin', 'round');
      if (style.dashArray) {
        this.hudInkPath.setAttribute('stroke-dasharray', style.dashArray);
      } else {
        this.hudInkPath.removeAttribute('stroke-dasharray');
      }
    }

    if (this.willAutoClose && this.hudCloseRing) {
      this.hudCloseRing.setAttribute('cx', String(round2(this.rawX[0])));
      this.hudCloseRing.setAttribute('cy', String(round2(this.rawY[0])));
      this.hudCloseRing.setAttribute('r', String(round2(Math.max(8 / zoom, style.effectiveWidth))));
      this.hudCloseRing.style.display = 'block';
    } else if (this.hudCloseRing) {
      this.hudCloseRing.style.display = 'none';
    }
  };

  mount() {
    const surface = this.surfaceElement;
    if (!surface || typeof surface.addEventListener !== 'function') {
      return () => {};
    }
    const doc = surface.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);

    // Document capture runs before every listener on the canvas itself, so SelectSuite's
    // capture-phase covered-press handler can never start a gesture that steals our capture.
    doc?.addEventListener?.('pointerdown', this.onPointerDown, { capture: true });
    surface.addEventListener('pointermove', this.onPointerMove, { capture: true });
    surface.addEventListener('pointerup', this.onPointerUp, { capture: true });
    surface.addEventListener('pointercancel', this.onPointerCancel, { capture: true });
    surface.addEventListener('lostpointercapture', this.onLostPointerCapture, { capture: true });
    win?.addEventListener?.('keydown', this.onKeyDown, true);
    win?.addEventListener?.('compositionstart', this.onCompositionStart, true);
    win?.addEventListener?.('compositionend', this.onCompositionEnd, true);
    win?.addEventListener?.('blur', this.onWindowBlur);

    return () => {
      doc?.removeEventListener?.('pointerdown', this.onPointerDown, { capture: true });
      surface.removeEventListener('pointermove', this.onPointerMove, { capture: true });
      surface.removeEventListener('pointerup', this.onPointerUp, { capture: true });
      surface.removeEventListener('pointercancel', this.onPointerCancel, { capture: true });
      surface.removeEventListener('lostpointercapture', this.onLostPointerCapture, { capture: true });
      win?.removeEventListener?.('keydown', this.onKeyDown, true);
      win?.removeEventListener?.('compositionstart', this.onCompositionStart, true);
      win?.removeEventListener?.('compositionend', this.onCompositionEnd, true);
      win?.removeEventListener?.('blur', this.onWindowBlur);
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
}
