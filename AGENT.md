# AGENT.md

Alid 외부 확장(`drawing.freehand`) 작업 지침입니다. 이 저장소는 **tldraw의 연필/자유 드로잉(`DrawTool` + `DrawShapeUtil` + `perfect-freehand`) 아키텍처**를 Alid의 **Canonical/Derived/Scratch 3계층 상태 모델**에 맞춰 **최적화 우선**으로 구현합니다.

---

## 1. 핵심 최적화 원칙 (Zero-GC & O(1) Transform)

1. **`pointermove` 0-GC & Zero Canonical Write**:
   - 드로잉 중 `pointermove`(및 `event.getCoalescedEvents()`)는 사전 할당된 `Float64Array`(`rawX`, `rawY`, `rawZ`)와 `Uint8Array`(`rawSeg`)에 스칼라 값만 기록합니다.
   - `pointermove`에서는 Canonical World(`world.setCanonical`, `applyCanonicalTransaction`)나 Undo 히스토리에 **절대 쓰지 않습니다**.
   - 라이브 프리뷰는 `canvas.frames`의 단일 `requestAnimationFrame` 틱(`flushFrame()`)에서 HUD `<svg class="alid-freehand-hud">` 오버레이 경로만 갱신합니다.
2. **정규화 로컬 바운딩 & `WeakMap` 파생 캐시**:
   - 스트로크 확정 시 모든 점은 로컬 `[0..baseWidth, 0..baseHeight]` 좌표계로 정규화(`normalizeStrokeGeometry`)되어 저장됩니다.
   - `deriveStrokeGeometry`는 동결(frozen)된 Canonical `props` 객체를 키로 하는 `WeakMap`에 로컬 윤곽선/중심선 SVG 경로를 캐싱합니다.
   - 따라서 엔티티 이동(`core.transform.x/y` 변경) 시 무거운 자유곡선 윤곽선 재계산 없이 **O(1)**에 캐시된 SVG 경로를 재사용하며, `core.bounds` 리사이즈 시에도 점 배열을 다시 쓰지 않고 비균일 스케일(`scaleX`, `scaleY`)을 즉시 반영합니다.
3. **반복형 Ramer–Douglas–Peucker (RDP) 점 단순화**:
   - `pointerup` 확정 시 사전 할당된 `Uint8Array` 마스크와 `Int32Array` 스택을 사용하는 비재귀 RDP(`simplifyStrokePoints`)로 공선(collinear) 중복 샘플을 제거하되, `Shift` 직선 세그먼트 경계(`seg === 1`)는 보존합니다.
4. **이차 베지어 중점 보간 (`M ... Q ... T ... Z`)**:
   - tldraw의 `getSvgPathFromStrokePoints`와 동일하게 연속 점들의 중점(midpoint)을 이차 베지어(`Q`/`T`) 제어점으로 컴파일하여 SVG 문자열 길이와 DOM 파싱 비용을 최소화합니다.

---

## 2. 불변식 (Invariants)

1. **확장 매니페스트 계약**: `extension.json`을 수정했으면 반드시 `pnpm build`로 `dist/plugin.js`와 `alid.extension.json`(SHA-256 해시 포함)을 함께 갱신해야 합니다.
2. **읽기 경로 무부작용 (Read-Triggers-Write 금지)**: `activate()`, `derive()`, `renderDom()`, `renderSvg()`, `dispose()`는 문서를 변경하거나 엔티티를 생성해서는 안 됩니다.
3. **단일 Undo/Redo 그룹**: 스트로크 1개 그리기는 `pointerup`에서 `canvas.creation.create()` 1회 호출로 커밋되어, `Cmd/Ctrl+Z` 1번으로 스트로크 전체가 취소/복구되어야 합니다.
4. **취소 무결성**: 드로잉 중 `Escape`, `pointercancel`, `lostpointercapture`, `window.blur` 발생 시 활성 드래프트만 즉시 폐기하고 Canonical World에는 **0건의 커밋**만 남아야 합니다.
5. **한국어/CJK IME 3중 가드**: `isComposing || keyCode === 229 || key === 'Process'` 및 `compositionend` 직후 16ms 윈도우 동안 `Escape`/`Enter`/`[`/`]` 단축키가 스트로크를 취소하거나 브러시를 전환하지 않아야 합니다.
6. **순수 SVG 출력**: `renderSvg()`는 `<foreignObject>`나 외부 URL을 포함하지 않는 순수 벡터(`<path>`)만 반환해야 하며 모든 속성을 이스케이프해야 합니다.

---

## 3. 완료 게이트

작업을 마치기 전에 아래 명령이 모두 통과해야 합니다.

```bash
pnpm build
pnpm test
pnpm check:dist
pnpm test:host
```
