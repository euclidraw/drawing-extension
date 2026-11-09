# `drawing.freehand` API & 아키텍처 레퍼런스

## 1. 확장 식별자 및 매니페스트 계약

| 항목 | 값 |
| --- | --- |
| Extension ID | `drawing.freehand` |
| Canonical Aspect ID | `drawing.freehand.stroke` |
| Computed Aspect ID | `computed.drawing.freehand.stroke` |
| HSM Tool State ID | `root.select.drawing.freehand` |
| Optional Dependency | `core.select-suite: "^0.1.0"` |

## 2. Canonical Aspect 스키마 (`drawing.freehand.stroke`)

```ts
export interface FreehandPoint {
  x: number;    // 로컬 [0..baseWidth] 좌표
  y: number;    // 로컬 [0..baseHeight] 좌표
  z?: number;   // 필압 [0..1] (기본값 0.5)
  seg?: 1;      // 직선 세그먼트 시작 앵커 마커
}

export interface FreehandStrokeProps {
  brush: 'pen' | 'fine' | 'marker' | 'highlighter';
  stroke: string;        // 기본 '#191f28'
  fill: string;          // 닫힌 스트로크 채우기 색상 (기본 'transparent')
  fillOpacity: number;   // [0..1] (기본 0.18)
  strokeWidth: number;   // [1..64] (기본 6)
  opacity: number;       // [0.05..1] (기본 1)
  thinning: number;      // [-0.95..0.95] 필압/속도에 따른 두께 변화율 (기본 0.55)
  smoothing: number;     // [0..1] 윤곽선 폴리곤 스무딩 (기본 0.55)
  streamline: number;    // [0..0.95] 포인터 입력 안정화 계수 (기본 0.5)
  taperStart: number;    // [0..120] 시작점 테이퍼 길이 (기본 0)
  taperEnd: number;      // [0..120] 끝점 테이퍼 길이 (기본 0)
  dash: 'solid' | 'dashed' | 'dotted';
  isClosed: boolean;     // 시작점과 끝점을 닫힌 루프로 연결할지 여부
  isPen: boolean;        // 실제 스타일러스 필압 데이터 포함 여부
  baseWidth: number;     // 정규화 기준 너비
  baseHeight: number;    // 정규화 기준 높이
  points: FreehandPoint[];
  segments?: Array<{
    type: 'free' | 'straight';
    startIndex: number;
    endIndex: number;
  }>;
}
```

## 3. 등록 커맨드 (`manifest.capabilities.commands`)

- `drawing.freehand:draw-tool`: 자유 드로잉 도구(`root.select.drawing.freehand`)를 토글합니다. (헤드리스/비-HSM 환경에서는 프리셋 스트로크를 삽입합니다.)
- `drawing.freehand:insert-stroke`: 지정한 프리셋(`wave`, `underline`, `circle`, `arrow-loop`, `zigzag`) 또는 포인트 배열로 스트로크 엔티티를 즉시 생성합니다.
- `drawing.freehand:simplify-stroke`: 선택된 스트로크에 반복형 RDP 단순화를 적용해 포인트 수를 줄입니다.
- `drawing.freehand:smooth-stroke`: 선택된 스트로크에 가중 이동 평균 스무딩을 적용해 곡선을 매끄럽게 정돈합니다.
- `drawing.freehand:toggle-close-stroke`: 선택된 스트로크의 닫힌 곡선(`isClosed`) 상태를 전환합니다.
- `drawing.freehand:cycle-brush`: 선택된 스트로크(또는 활성 드로잉 도구)의 브러시 모드를 `pen -> fine -> marker -> highlighter` 순으로 전환합니다.

## 4. Copilot 워크스페이스 도구 (`workspace.tools`)

- `drawing.freehand:presets` (`read`): 사용 가능한 브러시 모드, 선 스타일, 프리셋 목록 조회
- `drawing.freehand:search` (`read`): 현재 캔버스의 자유 드로잉 스트로크 엔티티 검색
- `drawing.freehand:plan-changes` (`write`): 스트로크 생성(`create`), 스타일 수정(`update`), 이동/스케일(`move`), 삭제(`delete`) 변경안을 `prepareChange` 승인 플로우로 생성
