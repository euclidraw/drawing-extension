# Euclidraw Freehand Drawing Extension (`drawing.freehand`)

tldraw의 연필/자유 드로잉(`DrawTool`, `Drawing` 상태, `DrawShapeUtil`, `perfect-freehand` 알고리즘)을 참고하여 **최적화 우선(Zero-GC 포인터 수집, WeakMap 경로 캐싱, 반복형 RDP 단순화)**으로 설계한 Alid 외부 확장입니다.

## 주요 기능 및 최적화 아키텍처

1. **tldraw 스타일 가변 두께 자유곡선 엔진 (`src/freehand.js`)**
   - **Streamline 스무딩 & 압력 시뮬레이션**: 포인터 떨림을 흡수하는 스트림라인 필터(`t = 0.15 + (1 - streamline) * 0.85`)와 실제 스타일러스 필압(`pointerType === 'pen'`) 및 이동 속도 기반 가상 필압(`RATE_OF_PRESSURE_CHANGE = 0.275`)을 모두 지원합니다.
   - **이차 베지어 중점 경로 컴파일 (`M ... Q ... T ... Z`)**: 윤곽선 다각형과 단일선 폴리라인을 매끄러운 이차 베지어 중점 곡선으로 컴파일하며, 짧은 탭/클릭은 자동으로 원형 점(`dot`) 경로로 렌더링합니다.
   - **4종 브러시 & 선 스타일**:
     - `pen`: 필압/속도 반응형 가변 두께 잉크 펜
     - `fine`: 일정 두께 모노라인 세필 펜 (GPU 폴리라인 가속 대상)
     - `marker`: 굵은 대비감의 캘리그라피 마커
     - `highlighter`: 반투명 와이드 형광펜
     - `solid` / `dashed` / `dotted` 선 스타일 및 닫힌 곡선 내부 채우기(`isClosed`, `fill`, `fillOpacity`) 지원
2. **0-GC 인터랙티브 드로잉 도구 (`src/draw-tool.js`, HSM: `root.select.drawing.freehand`)**
   - **사전 할당 TypedArray 링 버퍼**: `pointermove`(및 `event.getCoalescedEvents()`)마다 객체 할당이나 Canonical World 쓰기 없이 `Float64Array` 버퍼에 스칼라 좌표만 기록합니다.
   - **프레임당 1회 HUD 프리뷰**: `canvas.frames` 서비스와 연동해 디스플레이 주사율당 최대 1회만 HUD SVG(`<svg class="alid-freehand-hud">`) 경로를 갱신합니다.
   - **tldraw 제스처 호환**:
     - `Shift` 홀드: 이전 앵커에서 현재 포인터까지 **직선 세그먼트(Straight Line Mode)** 연결 (해제 후 다시 자유곡선 이어그리기 가능)
     - `Shift` + `Ctrl`/`Cmd`: **15° 단위 각도 스냅** 직선 그리기
     - `Alt` 홀드(시작점 근처): 시작점으로 스냅하며 **닫힌 도형(`isClosed: true`) 자동 완성**
     - `[` / `]`: 브러시 굵기 즉시 조절, `1`~`4`: 브러시 모드 즉시 전환
   - **한국어 IME 3중 가드 & 무결성 취소**: 조합 중(`229`/`isComposing`/16ms 윈도우) 키 이벤트를 보호하며, `Escape` / `pointercancel` / `blur` 시 Canonical 커밋 없이 드래프트를 즉시 폐기합니다.
3. **O(1) 이동 & 비균일 리사이즈 (`deriveStrokeGeometry`)**
   - 스트로크 포인트를 로컬 `[0..baseWidth, 0..baseHeight]`로 정규화하고 동결된 Canonical `props`를 키로 `WeakMap`에 로컬 SVG 경로를 캐싱합니다.
   - 엔티티 이동(`core.transform`) 시 윤곽선을 재계산하지 않으며, `core.bounds` 리사이즈 시에도 포인트 배열 재작성 없이 즉시 스케일링됩니다.
4. **정밀 해석적 선택 & GPU 폴리라인 기여 (`src/selection.js`)**
   - 스트로크 중심선 세그먼트 거리 기반 `hitTest`와 마키 박스 교차(`intersectsRect`), 선택 윤곽선(`getOutlinePath`), 균일 실선용 WebGPU 폴리라인(`getPolyline`)을 제공합니다.

## 빠른 시작

```bash
pnpm install
pnpm dev          # http://127.0.0.1:4173/alid.extension.json (SSE 자동 리로드)
pnpm build        # dist/plugin.js 및 alid.extension.json 빌드
pnpm test         # 단위/번들/데브서버/플러그인 계약 테스트
pnpm test:host    # 실제 Alid Rust Wasm + SceneVectorCompiler + HSM 통합 검증
```
