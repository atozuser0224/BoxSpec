# BoxSpec — 프로덕션 제품·기술·에이전트 연동 기획서

> **사람이 화면 구조를 결정하고, AI는 그 구조 안에서 구현한다.**
>
> 작성일: 2026-09-22 · 문서 버전: 1.0.0 · 제품명: BoxSpec(가칭, 상표·도메인 확보 여부 미확인)
>
> 이 문서는 구현을 위한 설계 명세다. 실행 가능한 데스크톱 앱이나 배포된 MCP 서버가 아니다. 문서에 등장하는 `boxspec_*` 도구, 패키지, 실행 파일은 **이 프로젝트에서 만들어야 할 인터페이스**이며 기존에 설치 가능한 제품으로 제시하지 않는다. 외부 기술의 확인된 기능과 이 문서의 설계 결정을 구분한다. 성능 수치는 측정 결과가 아니라 출시 전 검증할 목표다.

## 0. 최종 결정 요약

BoxSpec은 Windows용 **AI 코딩 에이전트의 시각적 UI 명세·검증 데스크톱 앱**이다. 사용자는 사각형으로 큰 영역을 배치하고 역할·배치 규칙·수정 가능 범위를 지정한다. BoxSpec은 이를 버전이 있는 Layout Contract로 저장한다. Codex, Claude Code, OpenCode는 MCP를 통해 계약·디자인 토큰·기존 컴포넌트·검증 결과를 읽고, 별도 작업 공간에서 UI를 구현한다. 실제 렌더링 결과가 계약과 테스트를 통과하고 사용자가 승인해야 원본 프로젝트에 반영한다.

핵심은 손그림을 코드로 바꾸는 것 자체가 아니라 **수정 요청이 누적되어도 사용자가 확정한 구조와 기존 기능을 유지하도록 생성·검증·승인을 연결하는 것**이다.

| 구분 | 확정 결정 |
|---|---|
| 제품 형태 | 로그인 없이 로컬에서 기본 기능을 사용하는 Windows 데스크톱 앱 |
| 기본 입력 | 프로그램 안에서 직접 그린 사각형·텍스트·중첩 영역. 그림의 픽셀 재인식이 아닌 구조화 데이터 |
| AI 역할 | 영역 내부 구현, 기존 컴포넌트 연결, 스타일 후보, 테스트·수정. 구조 변경은 별도 제안 |
| 핵심 엔진 | Layout Contract, 결정적 레이아웃 셸 생성기, 실제 렌더링 검증기, 변경·승인 엔진 |
| AI 연결 | 외부 에이전트 → BoxSpec MCP 서버가 정식 기본 경로 |
| 앱 내부 실행 | 별도 Agent Runner Adapter. MCP 연결만으로 에이전트가 자동 시작된다고 가정하지 않음 |
| 첫 정식 타깃 | React + TypeScript + Vite 기반 Web UI. Next.js는 별도 호환 프로필 검증 후 승격 |
| 후속 우선순위 | Unity uGUI → React Native Android. 최초 버전에 세 플랫폼을 동시에 완성했다고 주장하지 않음 |
| 데스크톱 스택 | Electron, React, TypeScript, SVG/HTML 기반 제한된 캔버스, Node 코어 서비스 |
| 로컬 모델 | 필수 아님. Laya/Jev 등 특정 모델의 미검증 기능·성능에 핵심 경로를 의존시키지 않음 |
| 기존 프로젝트 보호 | 생성 파일·허용된 UI 파일만 후보로 수집. 비즈니스 로직·인증·결제·저장·전체 스타일 변경은 기본 차단 |
| 출시 원칙 | 웹 화면 한 개의 draw → agent → render → verify → approve → apply → recover가 실제로 완주해야 기능 확장 |

### 0.1 반드시 지킬 불변식

1. 승인된 계약의 hard 필드는 에이전트가 변경할 수 없다. 변경 제안과 변경 승인은 별도다.
2. `검증 통과`는 서버가 수집한 증거로만 결정한다. 에이전트가 “완료”라고 말하는 것은 통과 조건이 아니다.
3. 검증한 후보와 승인·적용하는 후보는 동일한 해시여야 한다.
4. 사용자 작업·기존 설정·Git 변경 내역을 자동으로 버리거나 덮어쓰지 않는다.
5. MCP는 권한 제한·과금·샌드박스를 자동 제공하는 마법의 계층이 아니다.
6. 지원하지 않는 컴포넌트, 해상도, 상태, 플랫폼은 `UNSUPPORTED` 또는 `UNVERIFIED`로 표시한다.
7. 앱이 통제하는 적용 경로 밖에서 사용자가 별도 에이전트에 원본 파일 쓰기 권한을 주면, BoxSpec만으로 이를 차단할 수 없다.

## 1. 제품이 해결하는 문제와 해결하지 않는 문제

### 1.1 문제 정의

사용자가 AI에게 “이 부분만 바꿔”라고 요청했는데 상단 탐색, 카드 배치, 폰트 크기, 메뉴 폭까지 함께 달라진다. 매번 긴 텍스트로 구조를 다시 설명해야 하고, 마음에 드는 화면이 나와도 다음 수정에서 유지되지 않는다. 기존 프로젝트의 컴포넌트와 에셋이 있는데도 새 UI를 임의로 만들어 시각적 일관성과 기능 연결이 무너진다.

BoxSpec은 사용자 의도를 세 부분으로 분리한다.

- **구조:** 어떤 영역이 있고 어떻게 배치되는가. 사용자 소유.
- **표현:** 색상·타이포·아이콘·내부 컴포넌트를 어떻게 구성하는가. 승인된 디자인 시스템 안에서 AI가 작업.
- **동작:** 클릭, 데이터 표시, 로딩·오류 상태를 기존 코드와 어떻게 연결하는가. 바인딩 계약과 테스트로 보존.

### 1.2 성공 장면

사용자가 기존 앱을 연결하고 사이드바·헤더·본문·상세 패널 사각형을 그린다. 사이드바 너비와 상단 높이를 잠근다. “기존 다크 테마를 사용하고 본문만 목록형으로 바꿔”라고 지시한다. 에이전트는 MCP에서 선택 영역과 최신 계약을 읽는다. 검증 화면에는 `사이드바 이동 0`, `헤더 높이 유지`, `본문 4개 파일 변경`, `기존 검색 테스트 통과`가 나타난다. 사용자는 변경된 본문만 승인한다.

다음날 다른 에이전트로 “목록에 필터 추가”를 실행해도 같은 계약·토큰·컴포넌트 레지스트리를 사용한다.

### 1.3 비목표

첫 버전에 Figma 전체 대체, 자유 곡선·벡터 일러스트 편집, 실시간 공동 편집, 모든 프레임워크 자동 변환, 임의 앱의 완전한 역공학, 자동 결제·배포, 저작권이 불분명한 에셋 수집은 넣지 않는다. 이미지 입력만으로 기존 기능이 100% 복구된다는 약속도 하지 않는다.

외부 경쟁 제품이 특정 기능을 절대 지원하지 않는다는 가정으로 사업성을 정하지 않는다. 차별화 가설은 **에이전트가 교체돼도 유지되는 계약과 증거 기반 적용**이며, 실제 사용자 평가로 검증한다.

## 2. 사용자·플랫폼·출시 범위

### 2.1 주요 사용자

주 고객은 코드를 읽고 프로젝트를 실행할 수 있지만 전문 디자인 도구로 모든 화면을 완성하기는 부담스러운 개인 개발자·소규모 팀이다. 사용자가 원하는 경험은 “픽셀 단위 디자인 업무를 모두 떠맡기”가 아니라 “큰 틀은 직접 지시하고 반복 구현은 AI에게 맡기기”다.

### 2.2 지원 단계

| 단계 | 범위 | 완료 조건 |
|---|---|---|
| P0 내부 수직 구현 | Windows, 샘플 React/Vite 저장소, 단일 화면, 한 MCP 클라이언트 | 사각형 작성부터 승인·적용·복구까지 실제 실행 |
| P1 첫 정식 출시 | Windows, React/Vite, 기존 저장소 연결, Codex/Claude Code/OpenCode 외부 MCP | 저장·복구·보안·호환성·실제 에이전트 E2E 통과 |
| P2 Unity 확장 | uGUI, Screen Space Overlay, 생성 프리팹과 HUD | Unity Editor에서 실제 렌더·상호작용·해상도 검증 |
| P3 모바일 확장 | React Native Android, 명시적 컴포넌트 어댑터 | 실제 에뮬레이터에서 레이아웃·키보드·접근성 검증 |
| 별도 프로필 | Next.js, Unity UI Toolkit, iOS, macOS/Linux | 각각 설치·실행·회귀 기준을 통과한 조합만 공식 지원 |

P2/P3는 아래에 구현 가능한 어댑터 명세를 제시하지만 P1 바이너리의 지원 기능으로 광고하지 않는다. 같은 화면을 웹에서 Unity로 원클릭 완전 변환하는 기능은 범위 밖이다. **공통 의도 + 타깃별 구현·검증**이 원칙이다.

### 2.3 보장 수준

- **Managed:** BoxSpec이 소유한 레이아웃 셸과 슬롯. 생성 규칙과 검증 범위 안에서 강한 유지 보장.
- **Adopted:** 기존 UI에 노드 ID와 측정을 연결한 상태. 테스트한 상태·뷰포트에 한해 유지 여부를 검사.
- **Reference:** 스크린샷·디자인 참고만 등록. 추론 보조이며 코드 일치 보장은 없음.

화면·노드마다 수준을 표시한다. Adopted를 Managed와 동일한 보장으로 설명하지 않는다.

## 3. 전체 사용 흐름

### 3.1 처음 프로젝트를 연결할 때

1. 로컬 폴더를 선택한다. 폴더 탐색은 OS 대화상자로 한다.
2. 읽기 권한과 에이전트에 전달할 정보 범위를 보여준다. 초기에는 실행·쓰기·네트워크 권한을 부여하지 않는다.
3. `package.json`, 잠금 파일, 프레임워크 설정, 라우트와 UI 디렉터리를 읽어 프로필을 제안한다. 설치 스크립트는 실행하지 않는다.
4. 승인할 실행 프로필을 표시한다. 실행 파일·인자·작업 경로·환경 변수 이름·외부 접근 범위를 사용자가 확인한다.
5. Git 상태와 기준 커밋을 확인한다. 미커밋 변경이 있으면 숨기지 않는다. P1 controlled 적용은 깨끗한 기준 상태를 요구한다. 자동 stash·reset·clean은 금지한다.
6. 첫 화면에 한해 Managed 생성, Adopted 연결, Reference 참조 중 하나를 고른다.
7. 디자인 토큰과 재사용 컴포넌트 후보를 보여준다. 후보 추출이 완전하다고 표시하지 않는다.
8. 설치된 에이전트 버전을 검사하고 연결 설정을 생성한다. 기존 설정과의 diff를 보여준 다음 사용자 승인으로 병합한다.
9. `get_capabilities → get_context` 실제 호출을 확인해야 `연결됨`으로 표시한다.

Git이 없는 프로젝트도 캔버스 작성·계약 내보내기는 가능하다. 안전한 코드 적용을 쓰려면 사용자가 Git 도입을 승인해야 한다. 앱이 사용자 몰래 초기 커밋하지 않는다.

### 3.2 화면을 만드는 과정

`화면 추가 → 기준 크기 지정 → 사각형 그리기 → 역할 라벨 → 배치 보정 확인 → 구조 잠금 → 스타일 선택 → 작업 생성 → AI 구현 → 실제 결과 비교 → 승인`

사각형 하나마다 수십 개 속성을 입력하게 하지 않는다. 기본 질문은 `무슨 영역인가?`, `크기는 고정인가/남은 공간인가?`, `AI가 어디까지 바꿔도 되는가?` 세 가지다. 나머지는 상세 속성으로 접는다.

### 3.3 기존 화면 수정

사용자는 노드를 선택해 “여기만 바꿔”를 실행한다. 작업 범위에는 선택 노드뿐 아니라 영향을 받는 형제·조상·공용 컴포넌트·사용 화면을 계산한 dependency closure를 붙인다. 선택 밖의 geometry와 protected 기능은 회귀 검증 대상이다. 공용 컴포넌트를 바꾸면 사용 중인 다른 화면도 다시 검증하며, 단순히 선택 영역만 캡처해서 완료하지 않는다.

### 3.4 잠금과 요구가 충돌할 때

예: 사용자가 “버튼 두 개를 추가”했지만 240px 고정 폭 안에서 최소 글자 크기와 줄바꿈 금지를 동시에 만족할 수 없다.

앱은 무한 재생성하지 않고 `CONSTRAINT_CONFLICT`를 표시한다. `세로 배치`, `줄바꿈 허용`, `폭 확대`를 영향과 함께 제안한다. AI는 변경 요청을 제출할 수 있지만 hard 값을 직접 바꾸지 못한다. 사용자가 선택하면 새로운 계약 revision을 생성하고 기존 후보는 stale 처리한다.

## 4. 앱 자체의 UX·디자인 시스템

### 4.1 디자인 방향

작업 공간이 주인공인 개발 도구다. 불필요한 둥근 카드, 랜딩 페이지형 거대한 제목, 의미 없는 그라디언트·그림자·장식 아이콘을 사용하지 않는다. 편집기의 디자인 토큰과 사용자가 만드는 제품의 디자인 토큰은 완전히 별개다.

### 4.2 화면 구조

| 영역 | 기본 크기 | 내용 |
|---|---:|---|
| 상단 툴바 | 높이 48px | 프로젝트, 저장 상태, 화면·뷰포트, 에이전트 상태, 작업 버튼 |
| 왼쪽 패널 | 폭 232px, 조절 200–360px | Screens / Layers / Assets 탭 |
| 중앙 편집 영역 | 나머지 | 캔버스, 실제 결과, overlay 비교 |
| 오른쪽 속성 | 폭 304px, 조절 272–440px | 역할, 레이아웃, 잠금, 바인딩, 상태 |
| 하단 작업 패널 | 닫힘 28px / 펼침 240px | Jobs, Changes, Checks, Logs |

지원 최소 창 크기는 설계 목표 1100×720이다. 더 작은 창에서는 오른쪽 패널을 drawer로 전환한다. Windows 125%, 150%, 200% 배율과 다중 모니터 간 이동을 테스트한다.

### 4.3 편집기 토큰 — 구현 기준

| 토큰 | 다크 | 라이트 |
|---|---|---|
| `editor.background` | `#111318` | `#F6F7F9` |
| `editor.panel` | `#191C23` | `#FFFFFF` |
| `editor.canvas` | `#0D0F13` | `#ECEEF2` |
| `editor.border` | `#343A46` | `#D6DBE4` |
| `editor.text.primary` | `#F1F4FA` | `#19202B` |
| `editor.text.secondary` | `#B9C2D0` | `#4C586B` |
| `editor.accent` | `#8FAEFF` | `#275BCD` |
| `editor.warning` | `#F3C879` | `#865400` |
| `editor.error` | `#FF9B9B` | `#B4232D` |

색상은 제안값이며 출시 테스트에서 대비와 상태 구별을 측정한다. 글꼴은 시스템 UI 폰트와 한국어 시스템 대체 폰트를 사용한다. 외부 폰트 다운로드가 있어야 실행되는 구조를 금지한다. 기본 본문 13px/20px, 입력 13px, 섹션 제목 12px/18px semibold, 버튼 높이 32px, 주요 실행 36px. 작업에 쓰는 아이콘은 통일된 스타일을 쓰고 텍스트·tooltip을 함께 제공한다.

### 4.4 편집 상호작용

- `R`: 영역 그리기. `V`: 선택. `Space+drag`: 이동. `Ctrl+wheel`: 확대. `F`: 선택 맞춤.
- `Ctrl+D`: 복제. `Ctrl+G`: 그룹. `Ctrl+Shift+G`: 그룹 해제. `Ctrl+Z/Y`: undo/redo.
- 방향키: 1 논리 단위 이동, Shift: 8. 텍스트 편집 중에는 단축키를 가로채지 않는다.
- 다중 선택, 정렬, 간격 맞춤, 중첩, 다른 부모로 이동을 제공한다. 부모 변경은 별도 표시한다.
- 핸들·선택 테두리는 확대와 무관하게 screen-space 일정 두께를 유지한다.
- 드래그 중에는 임시 로컬 상태만 변경하고 포인터를 놓을 때 하나의 command로 저장한다.
- 한글 IME composition 중 Enter로 라벨을 확정하거나 단축키를 실행하지 않는다.
- 포커스 순서는 toolbar → 좌측 → canvas → inspector → jobs. 모든 핵심 작업에 키보드 대안을 둔다.

### 4.5 노드 배지와 상태

`고정`, `범위 허용`, `AI 편집`, `기존 코드`, `검증 안 됨`을 텍스트와 아이콘으로 표시한다. 색만으로 구별하지 않는다. AI 후보는 점선 overlay, 사용자 승인 구조는 실선이다. 실제 결과 화면과 참고용 캔버스를 명확히 구분한다.

작업 버튼 상태는 `연결 필요`, `구현 요청`, `진행 중`, `수정 필요`, `검토 가능`, `승인 및 반영`, `원본 변경으로 재검증 필요`다. 비활성 버튼에는 이유가 있어야 한다.

## 5. 캔버스와 사각형의 의미

### 5.1 기본 원칙

앱 안에서 그린 사각형은 이미 좌표·크기·부모·순서가 있는 객체다. 이를 매번 스크린샷으로 바꿔 vision 모델에 읽히지 않는다. 그림 이미지 입력은 선택 기능이며, 추출 결과를 사용자가 확정한 뒤에만 같은 구조 객체로 전환한다.

### 5.2 최초 그리기와 레이아웃 변환

처음에는 `sketchBounds`를 저장한다. 위치를 보고 row/column/grid/overlay 후보를 제시할 수 있지만 그 추론을 바로 계약으로 확정하지 않는다. 부모 자동 후보는 완전 포함을 우선하고, 겹치는 부모가 둘 이상이면 선택을 요구한다. 단순 overlap을 nesting으로 오인하지 않는다.

기본 변환은 다음과 같다.

| 입력 | 제안 | 사용자 확인 |
|---|---|---|
| 높이가 비슷한 박스가 가로로 반복 | row | 순서·간격·줄바꿈 여부 |
| 너비가 비슷한 박스가 세로로 반복 | column | 고정 높이/콘텐츠 높이 |
| 행·열 반복 | grid | 열 개수·최소 폭 |
| HUD·겹치는 패널 | overlay | anchor·offset·z-order |
| 내용 없는 큰 영역 | container/content | 역할 라벨 |

추론은 `추천`이다. 보정으로 박스가 이동한다면 이동 전후를 보여준다. 근거 없는 96% 같은 신뢰도 수치를 만들지 않는다. 휴리스틱 판단이면 `명확/확인 필요` 수준으로 표시한다.

### 5.3 구조 단위

- Screen: 하나의 라우트/게임 화면/모바일 화면 명세.
- Node: 레이아웃을 갖는 영역. 안정적인 ID를 사용하며 이름 변경으로 ID를 바꾸지 않는다.
- Slot: AI 또는 기존 컴포넌트가 들어가는 내부 구현 지점.
- Component Definition: 공용 형태와 허용 props.
- Component Instance: screen 안에서 쓰이는 특정 인스턴스.
- Fixture/State: 실제 검증에 사용하는 데이터·화면 상태.

단순 그룹과 의미 있는 컨테이너를 구분한다. 그룹 해제가 코드의 부모/자식 관계를 바꾸는 작업이라면 구조 변경으로 취급한다.

## 6. Layout Contract — 정규 데이터 모델

### 6.1 저장 단위와 권위

승인된 `contract.json` + 디자인 토큰 + 바인딩 레지스트리가 구조 의도의 원본이다. 실제 코드는 구현의 원본이다. 둘을 자동으로 양방향 완벽 동기화한다고 주장하지 않는다.

외부 코드 변경을 감지하면 diff와 `drift`를 생성한다. 사용자는 `코드를 계약에 반영하는 제안`, `계약대로 코드 복구`, `해당 영역 관리 해제` 중 선택한다. 외부 변경을 발견했다고 승인된 계약을 자동 수정하지 않는다.

이 패키지의 `contracts/layout-contract.schema.json`은 핵심 데이터의 JSON Schema이고 `examples/dashboard.contract.json`은 검증 가능한 예제다. 스키마로 표현하기 어려운 부모 순환·존재하지 않는 참조·breakpoint 충돌·제약 충돌은 semantic validator에서 검사한다.

### 6.2 핵심 속성

| 객체 | 필수 의미 |
|---|---|
| Contract | schemaVersion, projectId, screenId, revision, target, rootNodeId |
| CoordinateSpace | unit: css-px / canvas-unit / dp, origin: top-left |
| Node | id, parentId, order, role, layout, placement, locks, slot |
| Layout | mode, width/height sizing, padding, gap, align, justify |
| ResponsiveOverride | breakpoint별 layout·visibility override |
| Assertion | 실제 렌더링에 대한 numeric/relation/visibility/overflow 규칙 |
| VerificationProfile | 뷰포트, fixture, 필수 검사, 수치 오차 |
| DesignSystem | token revision, token 값, 허용 컴포넌트 |
| Binding | 슬롯 구현 경로, export symbol, props·이벤트 연결 계약 |

### 6.3 크기와 좌표

크기는 `fixed`, `fill`, `hug` 세 모드를 기본으로 한다. 같은 축에서 fixed 부모와 넘치는 fixed 자식이 충돌하면 오류다. hug 부모에 부모 크기를 요구하는 fill 자식이 있으면 순환 의존 가능성을 검사한다. CSS `flex-shrink`가 고정 폭을 몰래 줄이지 않도록 fixed는 기본 shrink 0으로 내보낸다.

캔버스 줌·Windows DPI·실제 렌더링 DPR은 계약 논리 단위와 분리한다. `canvasPoint = (screenPoint - viewportOrigin - pan) / zoom`으로 변환한다. 최종 출력에 캔버스 확대 배율을 곱하지 않는다.

부동소수 오차 때문에 수치 비교에 오차를 둔다. 논리 값은 소수점 3자리로 정규화하되, 손실성 픽셀 반올림을 반복하지 않는다. Contract hash는 key 정렬·수치 정규화가 고정된 canonical JSON으로 계산한다.

### 6.4 반응형

잠금의 기본 단위는 “모든 해상도에서 좌표 동일”이 아니라 **각 breakpoint에서의 관계와 크기 규칙**이다. 예를 들어 데스크톱 sidebar 폭 260, compact에서 숨김, main은 남는 폭 채움은 충돌하지 않는다.

breakpoint는 최소 폭 포함·최대 폭 제외다. 중복·빈틈은 정책적으로 검사한다. 기본 screen 지원 폭은 320–2560 논리 단위로 설정할 수 있지만 검증한 폭과 전체 지원 범위를 혼동하지 않는다. 실제 검증에는 대표 폭, breakpoint 직전/정확/직후, 긴 텍스트, 빈 데이터, 작은 높이를 포함한다.

AI가 “모바일용으로 좋아 보여서” 순서를 바꾸려면 override 계약 변경이 필요하다. compact 계약이 없으면 임의 모바일 구조를 확정하지 않는다.

### 6.5 잠금 정책

| 정책 | 의미 | 적용 |
|---|---|---|
| Hard | task가 참조한 승인값 또는 규칙 변경 불가 | 계약 patch 차단 + 실제 렌더링 검사 |
| Soft | 승인된 명시 범위 안에서만 변경 가능 | 예: gap 12–20; 단위·대상 속성 필수 |
| Free | AI가 변경 가능 | 그래도 타입·접근성·전체 제약은 통과해야 함 |

기본값은 topology/layout hard, presentation free, content hard다. 사용자는 슬롯의 문구를 free로 바꿀 수 있다. Soft 범위를 지정하지 않았으면 “대충 비슷하게”로 해석하지 않고 입력 오류로 처리한다.

부모 padding, 전역 CSS, 공용 token, 상위 transform 변경으로 자식 hard 위치를 우회할 수 있으므로 **잠긴 필드의 문자열만 검사해서는 안 된다.** 조상 영향과 최종 geometry를 검사해야 한다. hard는 user가 못 바꾸는 잠금이 아니라 agent가 승인 없이 못 바꾸는 계약이다.

### 6.6 후보별 허용 레이아웃 변경

Soft/Free를 화면에 표시만 하고 실제로는 사용할 수 없는 기능으로 만들지 않는다. 에이전트는 `submit_candidate.layoutOverrides`로 `nodeId + /layout/... JSON Pointer + scalar value`를 제출한다. Core는 승인 계약에 override를 적용한 effective contract를 만들고, 해당 경로가 soft 범위 또는 free인지 확인한 뒤 컴파일한다. Hard 경로는 거절한다. 생성된 셸 파일을 직접 편집하는 우회 경로는 허용하지 않는다.

P1 override는 기존 layout의 scalar leaf만 지원한다. 예: `/layout/gap`을 16에서 20으로 변경, `/layout/width/value`를 허용된 범위에서 변경. 부모·자식·순서·node 생성/삭제는 모두 사용자 승인 계약 변경으로 처리한다. schema의 topology 정책도 P1에서는 hard만 허용한다. scalar 변경 뒤 sizing 조합이 불완전해지면 semantic validation 실패다.

후보 manifest에는 base contractHash와 effectiveContractHash, layoutOverridesHash를 모두 저장한다. Report와 승인은 세 값에 묶는다. 승인·적용 후 허용 override를 다음 승인 계약 revision의 현재 값으로 저장하며, 해당 revision publish도 동일한 apply journal에 포함한다. revision/hash가 바뀌므로 진행 중인 관련 작업을 stale 처리한다. 이를 처리하지 않으면 다음 수정에서 soft 변경이 되돌아오는 문제가 생긴다.

### 6.7 충돌 처리

우선순위는 `보안·프로젝트 보호 정책 → 사용자 승인된 hard → 승인된 responsive/state → soft 범위 → AI 미적 선호`다. hard끼리 충돌하면 어떤 것을 몰래 낮추지 않고 conflicting node/rule을 보고한다. 가능하면 최소 충돌 집합에 가까운 설명을 제공하되 수학적 최소성은 보장하지 않는다.

## 7. 컴포넌트·스타일·기능 바인딩

### 7.1 레이아웃 셸과 표현 슬롯의 분리

Managed Web 출력 예:

```text
src/boxspec/generated/dashboard.layout.tsx   # 결정적 생성; 에이전트 직접 수정 금지
src/boxspec/generated/dashboard.layout.css   # 결정적 생성; 토큰·계약에서 생성
src/boxspec/slots/ProjectList.tsx             # 에이전트 구현 허용
src/boxspec/slots/ProjectList.module.css      # scope된 표현 스타일
src/boxspec/bindings/dashboard.bindings.ts   # 사용자 승인 바인딩
```

셸은 구조·슬롯 위치·node ID를 소유한다. 슬롯은 root 폭/높이를 임의로 확장하지 못하는 계약을 가진다. overflow를 숨겨서 위반을 은폐하지 않도록 별도로 content clipping과 상호작용 영역을 검사한다.

### 7.2 디자인 시스템

프로젝트당 색상, 타이포, spacing, radius, border, shadow, icon family를 버전 관리한다. 토큰은 사람이 승인한 저장값이다. AI가 예쁜 새 색을 만들었다고 글로벌 token에 자동 등록하지 않는다.

스타일 최초 선택은 같은 구조 위에 최대 3개 후보를 비교한다. 후보는 동일한 geometry를 유지한다. 사용자가 하나를 선택하면 이후 수정은 해당 토큰과 component family에 종속된다. 후보 A의 헤더와 후보 B의 목록을 무심코 합쳐 스타일을 혼합하지 않는다.

`primary action은 화면당 반드시 하나` 같은 임의 디자인 규칙을 모든 프로젝트에 하드코딩하지 않는다. 제품별로 승인된 규칙만 적용한다.

### 7.3 재사용 우선

컴포넌트 레지스트리는 import path, export symbol, props schema, event contract, slot compatibility, style constraints, source hash를 저장한다. 탐색 우선순위는 `명시 지정 → 등록된 공용 컴포넌트 → 검색 후보 → 새 생성 제안`이다.

에셋은 사용자가 지정한 프로젝트 폴더에서 찾는다. hash, 크기, 형식, source path, 라이선스 메모를 기록한다. Unity의 sprite, font, material은 후속 어댑터에서 GUID 기반으로 연결한다. 파일 이름이 같은 다른 에셋을 자동 교체하지 않는다.

### 7.4 동작 보존

데이터 fetch, store, route, auth, payment, save, game economy 같은 로직은 기본 protected 영역이다. UI 구현은 기존 hook/controller/handler를 가져다 쓰고 변경하지 않는다.

Binding은 `onSearch → existing search handler`, `items → existing selector`, `onBuild → existing game action`처럼 명시한다. 스타일 작업에서 이를 stub 데이터로 교체해놓고 실제 기능이 된다고 보고하면 실패다. 프리뷰 fixture와 프로덕션 바인딩을 경로·빌드 플래그로 분리한다.

## 8. 시스템 아키텍처

```text
사용자
  │ draw / lock / review / approve
  ▼
Electron Editor Renderer ──좁은 IPC── Electron Main
                                      │
                                      ▼
                         Core Service (Node utility process)
                         ├─ Contract / Command Store
                         ├─ Constraint Validator / Compiler
                         ├─ Project / Asset Index
                         ├─ Jobs / Snapshot / Change Manager
                         ├─ Verifier / Evidence Store
                         └─ Agent Runner Adapters (선택)
                                      ▲
                                      │ 인증된 local IPC
외부 에이전트 → stdio MCP Bridge ──────┘
                                      │
                                      ▼
                       작업 worktree → 고정 후보 snapshot
                                      │
                                      ▼
                    제한된 preview runner / browser / Unity
                                      │
                                      ▼
                        실제 측정·캡처 → UI 승인 → 적용
```

### 8.1 프로세스 책임

Editor renderer에는 filesystem, child_process, 임의 IPC 접근을 주지 않는다. Main은 OS 창·파일 대화상자·승인 UI와 IPC 발신자 검사를 담당한다. Core는 계약·저장소·정책의 단일 writer다. MCP bridge는 protocol 변환과 최소 인증만 담당하며 독립 DB를 만들지 않는다.

Electron `utilityProcess`는 코어 프로세스 분리의 기반으로 선택한다. 프로세스가 분리됐다고 filesystem sandbox가 생기는 것은 아니다. [S08, S09]

### 8.2 스택 선택

| 계층 | 선택 | 이유·제한 |
|---|---|---|
| Desktop | Electron 안정 릴리스 | Node 도구·MCP·preview 통합을 단일 TS 코드베이스로 관리. 메모리 비용은 측정 |
| Editor | React + TypeScript | 컴포넌트화, 명시 타입, 선택·속성 패널 |
| Canvas | SVG overlay + HTML DOM | 사각형·라벨·그룹만 필요한 제한된 에디터. 초기부터 대형 범용 디자인 엔진을 만들지 않음 |
| State | command reducer + Zustand/동급 소형 store | 드래그 임시 상태와 영속 command 분리 |
| Validation | JSON Schema 2020-12 + semantic validator | 입력 경계에서 unknown 검사; TS 타입만 믿지 않음 |
| MCP | 공식 TypeScript SDK 검증 버전 | 직접 protocol 재구현 금지; 버전 호환 테스트 필요 |
| Runtime cache | SQLite | job/event/index를 단일 writer로 관리; layout 원본은 Git 친화적 JSON |
| Web verification | Playwright + 자체 geometry evaluator | 이미지 유사도만으로 통과시키지 않음 |
| Build | pnpm workspace + lockfile | 정확한 의존성 조합 기록; 설치 당시 안정 버전 검증 |

최신 major를 추측해서 package.json에 쓰지 않는다. 첫 개발 단계에서 실제 설치 가능한 안정 버전과 라이선스를 확인하고 `docs/compatibility.md`에 고정한다. 공식 MCP SDK 저장소는 조회 시 v2 split package와 2026-07-28 규격을 설명하고 있다. 이 기획은 해당 세대를 기준으로 하되 legacy 클라이언트 조합도 실제 시험 후 지원한다. [S02]

### 8.3 에디터 성능 설계

화면 밖 노드 virtualize, 선택 hit-test 공간 인덱스, drag 중 전체 tree 재렌더 금지, 이미지 썸네일 해시 캐시, 대형 에셋 lazy load를 적용한다. 처음부터 WebGL을 채택하지 않는다. 성능 측정에서 SVG/DOM 병목이 확인될 때 renderer adapter 교체를 검토한다.

## 9. 저장·버전·복구

### 9.1 파일 레이아웃

```text
<사용자 프로젝트>/
  .boxspec/
    project.json                 # non-secret portability metadata
    screens/dashboard.contract.json
    design/tokens.json
    components/registry.json
    bindings/dashboard.json
    fixtures/manifest.json
    policies/project-policy.json
    approved-baselines/manifest.json
  src/boxspec/                   # 승인된 타깃 출력

%LOCALAPPDATA%/BoxSpec/
  runtime/                       # 세션·local IPC discovery, 사용자 ACL
  projects/<project-id>/
    state.sqlite
    snapshots/<candidate-id>/
    artifacts/<sha256>/
    journals/<transaction-id>.json
    credentials/                 # OS 보호 저장소 참조; raw token Git 금지
```

`.boxspec`의 로컬 정책 파일이 에이전트에 의해 바뀌었다고 Core 권한이 바뀌면 안 된다. 실제 trust grant는 사용자 프로필의 별도 승인 기록으로 관리하고, project-policy.json은 변경 제안·이동성 메타데이터다.

### 9.2 영속화

모든 편집은 command ID, expectedRevision, actor, timestamp, 변경 전후 hash를 가진다. SQLite commit 후 저장 완료 응답을 보낸다. JSON export는 임시 파일 작성·fsync·원자적 교체를 사용하고 실패 시 DB snapshot에서 재생성한다. DB의 승인 snapshot과 export가 다르면 startup에서 reconciler가 복구 UI를 띄운다.

Core 하나만 write 권한을 갖는다. 외부 JSON 수정은 새 import draft다. 여러 bridge가 각각 저장하거나 revision을 발급하지 않는다. Undo는 새 command이며 파일 전체를 과거 상태로 강제 교체하지 않는다.

### 9.3 스키마 마이그레이션

migration 전 백업, schema 검사, 업그레이드 함수의 결정성 검사, 전체 semantic validation, 성공 후 publish 순서다. 지원하지 않는 미래 major는 read-only로 연다. 필드를 모른다고 삭제 후 저장하지 않는다. 다운그레이드가 안전하지 않으면 별도 export만 허용한다.

### 9.4 원본 적용과 실패 복구

여러 파일을 바꾸는 작업을 filesystem 차원의 단일 원자적 transaction이라고 주장하지 않는다. 다음 절차로 복구 가능성을 만든다.

1. 전체 후보·검증 report·계약 revision·기준 commit hash를 고정한다.
2. 사용자 승인 직전 original branch/HEAD/파일 hash가 기준과 같은지 다시 확인한다.
3. 변경 파일별 before/after hash와 백업 경로를 journal에 기록하고 fsync한다.
4. temp 파일을 준비하고 경로·권한·디스크 공간을 확인한다.
5. 파일 교체를 순차 수행하며 journal 단계 갱신.
6. 최종 hash가 후보와 동일한지 확인 후 APPLIED.
7. 중간 crash는 다음 시작에서 복구한다. 파일이 before/after 어느 쪽도 아니면 사용자 변경으로 보고 자동 덮어쓰기 금지.

복구는 `해당 transaction 변경만`을 대상으로 한다. `git reset --hard`, `git clean`, 사용자 작업 삭제를 쓰지 않는다. 사용자 Git commit/push는 별도 명시 선택이다.

## 10. MCP 연결 설계

### 10.1 MCP 역할

Codex/Claude Code/OpenCode가 MCP client이고 BoxSpec이 server다. 외부 에이전트가 계약과 검증 도구를 호출한다. MCP 자체가 모델 구독을 합치거나 무료 API 사용권을 만들지 않는다. 각 에이전트의 인증·요금·사용량 정책은 해당 도구에서 적용된다.

세 클라이언트의 공식 문서는 로컬 MCP 연결을 설명한다. 다만 설정 파일 형식이 다르므로 하나의 JSON을 모든 클라이언트에 복사하지 않는다. [S03, S04, S05]

### 10.2 기본 전송

P1은 로컬 stdio MCP bridge다. 클라이언트가 bridge process를 시작하고 bridge가 실행 중인 BoxSpec Core에 연결한다. 표준 출력은 MCP 메시지 전용, 로그는 stderr와 로컬 로그 파일이다. [S01, S18]

Core와 bridge의 내부 IPC는 MCP가 아니다. Windows에서는 사용자 권한으로 접근을 제한한 named pipe를 사용한다. 설치용 launcher는 small native executable로 만들고, 서명된 앱에 동봉된 검증 Node runtime과 bridge entry를 실행한다. 사용자가 전역 Node를 따로 설치해야 연결되는 형태는 정식 배포 기본값이 아니다.

개발 모드에서는 `node <absolute-path>/apps/mcp/dist/index.js --profile <id>`를 사용한다. 정식 설정에는 launcher의 절대 경로를 기록한다. 존재하지 않는 npm 패키지를 `npx -y`로 받으라고 안내하지 않는다.

### 10.3 로컬 인증·pairing

Core 최초 실행 시 사용자 프로필에 임의 discovery ID를 저장한다. bridge는 사용자 ACL로 보호된 discovery를 읽고 연결 요청을 보낸다. Desktop UI는 클라이언트 이름·요청 프로젝트·읽기/후보 쓰기/검증 범위를 표시한다. 사용자가 승인하면 프로세스별 short-lived grant를 발급한다.

`프로젝트 파일을 읽을 수 있다`와 `실행할 수 있다`는 별개 권한이다. MCP 요청의 clientInfo는 자기 선언이므로 강한 신원 인증으로 쓰지 않는다. 같은 사용자 계정의 악성 프로세스·관리자 권한 공격까지 방어한다고 주장하지 않는다.

앱이 종료된 경우 bridge는 프로토콜 자체는 응답하되 도구에 `APP_NOT_RUNNING`을 반환한다. GUI를 임의로 중복 실행하거나 숨은 Core를 새로 만들지 않는다. headless Core는 추후 별도 기능이다.

### 10.4 프로토콜 버전

규격 수명주기·초기화·capability 처리는 공식 SDK에 위임한다. 2026-07-28 세대와 과거 연결형 초기화 규격을 혼합해 수동 구현하지 않는다. bridge는 `client version / negotiated protocol / SDK version / tool schema version`을 진단에 기록한다. 읽기·도구 호출·이미지·취소를 조합별로 실제 시험한다. [S01, S19]

장시간 렌더는 app-level `jobId`를 즉시 반환하고 `get_task`로 조회한다. MCP Tasks 확장, server sampling, elicitation 지원을 기본 경로의 필수 조건으로 삼지 않는다. resources를 잘 노출하지 않는 클라이언트도 `get_context`, `get_report`, `get_artifact` 도구로 같은 데이터를 얻을 수 있어야 한다.

### 10.5 도구 목록

모든 이름은 BoxSpec이 구현할 도구다. 상세 입력·출력 스키마는 `contracts/mcp-tools.json`에 수록한다.

| 도구 | 목적 | 권한·중요 조건 |
|---|---|---|
| `boxspec_get_capabilities` | server/adapter/protocol 가능 기능 | 읽기 |
| `boxspec_list_projects` | pairing 승인된 프로젝트만 조회 | 다른 로컬 경로 탐색 불가 |
| `boxspec_get_selection` | 현재 screen/node 선택과 revision | 선택 변경은 계약 변경과 별개 |
| `boxspec_get_context` | 계약 조각·토큰·바인딩·영향 범위 | expectedRevision 필수 |
| `boxspec_search_assets` | 승인 asset index 조회 | 파일명·해시·썸네일 ID; raw 경로 제한 |
| `boxspec_start_task` | scope 고정 작업과 worktree 준비 요청 | 승인 실행 프로필만 사용 |
| `boxspec_get_task` | 상태·이벤트·허용 다음 동작 조회 | cursor 기반 bounded 응답 |
| `boxspec_propose_patch` | 파일 도구 없는 agent용 후보 파일 변경 | staging만, 보호 경로·payload 검사 |
| `boxspec_submit_candidate` | 작업 tree를 고정 후보로 수집 | 후보 hash·변경 파일 검사 |
| `boxspec_verify_candidate` | 신뢰 verifier로 실제 검사 시작 | shell 문자열 불가 |
| `boxspec_get_report` | 검사 결과·위반 근거 조회 | agent가 report를 덮어쓸 수 없음 |
| `boxspec_get_artifact` | 캡처·diff·측정 JSON 제공 | artifact ID만; 임의 URI fetch 금지 |
| `boxspec_propose_contract_change` | hard 충돌 해결용 변경 제안 | 승인 전 계약 불변 |
| `boxspec_request_review` | 통과 후보를 사용자 승인 대기열로 | 적용하지 않음 |
| `boxspec_cancel_task` | 소유 작업 취소 요청 | 대상 task 한정 |

**`approve`, `unlock`, `apply_to_main`, `run_shell`, `delete_project`, `read_secret` 도구를 노출하지 않는다.** 승인·잠금 해제·원본 반영은 trusted UI에서만 발생한다.

### 10.6 응답·오류·멱등성

정상 결과는 `structuredContent`와 간결한 JSON text fallback을 함께 제공한다. 출력 schema를 명시하고 validation을 통과한 값만 보낸다. 이미지가 필요하면 표준 image content로 제공한다. 파일을 로컬에 생성했다고 원격/클라우드 client가 해당 경로를 읽을 수 있다고 가정하지 않는다. [S06]

도구 domain 오류는 `isError:true`, `ok:false`, `code`, `message`, `recoverable`, `requestId`, 선택적 details로 반환한다. schema/protocol 오류와 business 오류를 구분한다.

대표 코드: `APP_NOT_RUNNING`, `PAIRING_REQUIRED`, `PROJECT_NOT_GRANTED`, `REVISION_CONFLICT`, `OUT_OF_SCOPE`, `PROTECTED_PATH`, `CONSTRAINT_CONFLICT`, `UNSUPPORTED_ADAPTER`, `UNSUPPORTED_CAPABILITY`, `EXECUTION_APPROVAL_REQUIRED`, `CANDIDATE_STALE`, `VERIFY_FAILED`, `CANCELLED`, `RESOURCE_LIMIT`, `DIRTY_BASELINE`, `APPLY_CONFLICT`.

쓰기성 도구에는 requestId가 필수다. 같은 principal·requestId·동일 canonical payload는 기존 결과를 반환한다. 같은 requestId에 다른 payload는 오류다. 작업 lease와 base revision을 재확인해 중복 실행·오래된 후보 적용을 막는다.

### 10.7 큰 문맥의 분할

`get_context.contractSliceJson`은 완전한 Layout Contract가 아니라 `contracts/context-slice.schema.json`의 읽기 전용 조각을 JSON 직렬화한 값이다. 클라이언트가 nested schema를 지원하지 않는 경우도 처리하기 위한 텍스트 필드이며, Core는 직렬화 전 slice schema를 검증한다. slice에는 전체 contractHash, revision, scope, 실제 포함 node, 관련 assertion과 cursor가 있다. 이를 승인 contract 파일로 저장하거나 compiler input으로 사용하면 안 된다.

선택 node와 최소 조상·관련 형제를 우선 담고 큰 자식 목록·에셋은 cursor로 분할한다. 모든 페이지는 같은 frozen contextHash에 묶인다. 문서가 변경되면 기존 cursor를 새 데이터에 이어 붙이지 않고 REVISION_CONFLICT를 반환한다. 하나의 node가 payload 한도를 넘으면 내용을 누락하고 정상 완료하지 말고 RESOURCE_LIMIT 또는 별도 artifact 경로를 제공한다. 관련 규칙·protected scope는 토큰 절약을 이유로 생략하지 않는다.

### 10.8 Resources / Prompts

URI 예: `boxspec://projects/<id>/screens/<screen-id>?revision=7`, `boxspec://tasks/<task-id>`, `boxspec://artifacts/<artifact-id>`.

Prompts: `implement_selection`, `repair_violations`, `review_candidate`. prompts 지원이 없어도 `get_context` 응답과 생성 handoff 파일로 실행할 수 있다. 중요한 가드레일은 prompt에만 두지 않고 Core가 검사한다. MCP Resources는 문맥 제공에 사용한다. [S07]

## 11. 실제 에이전트 연결 설정

아래는 **BoxSpec을 구현·빌드한 후** 사용할 형식 예제다. `C:/DEV/BoxSpec/...`는 예시 절대 경로이며 설치 마법사가 실제 경로로 만든다. 기존 설정 전체를 교체하지 않고 해당 항목만 병합한다.

### 11.1 Codex

```toml
[mcp_servers.boxspec]
command = "node"
args = ["C:/DEV/BoxSpec/apps/mcp/dist/index.js", "--profile", "default"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Codex는 공식 문서상 `config.toml`의 MCP server 구성을 사용한다. 지원되는 설치에서는 project-scoped 설정도 가능하다. 설정 작성 후 실제 도구 호출을 확인한다. [S03]

### 11.2 Claude Code

```json
{
  "mcpServers": {
    "boxspec": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/DEV/BoxSpec/apps/mcp/dist/index.js", "--profile", "default"]
    }
  }
}
```

project `.mcp.json` 병합 예제다. CLI 등록 시 stdio command와 client 옵션 사이의 `--` 구분을 지킨다. project-scoped server 승인 흐름을 사용자에게 남긴다. [S04]

### 11.3 OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "boxspec": {
      "type": "local",
      "command": ["node", "C:/DEV/BoxSpec/apps/mcp/dist/index.js", "--profile", "default"],
      "enabled": true
    }
  }
}
```

OpenCode는 공식 문서의 `mcp` 및 local command 배열 형식을 사용한다. Codex TOML 또는 Claude의 `mcpServers` 형식을 그대로 넣지 않는다. [S05]

### 11.4 연결 확인

앱 상태는 `구성 파일 생성`과 `연결 완료`를 구분한다. 에이전트에서 capabilities가 보이고 실제 screen contract revision을 읽었을 때만 초록 상태로 전환한다. 잘못된 CLI, 경로의 공백·한글, stdin/stdout 로그 혼입, 앱 미실행, 프로젝트 미승인, 프로토콜 비호환을 독립적으로 진단한다.

## 12. 앱의 ‘구현 시작’ 버튼과 Agent Runner

### 12.1 두 모드

**외부 에이전트 모드(정식 기본):** BoxSpec이 작업·worktree·handoff prompt를 준비한다. 사용자는 사용 중인 Codex/Claude Code/OpenCode에 지시한다. 에이전트가 MCP를 호출한다. 앱이 외부 채팅을 자동으로 조작하지 않는다.

**Managed Runner 모드(어댑터별 승격):** BoxSpec이 사용자가 설치·인증한 agent executable/공식 SDK를 실행하고 이벤트·취소·승인 요구를 연결한다. 모델 인증 파일을 복사하거나 계정 토큰을 추출하지 않는다.

### 12.2 어댑터 계약

```ts
interface AgentRunnerAdapter {
  detect(): Promise<AgentInstallation[]>;
  checkCapabilities(installationId: string): Promise<RunnerCapabilities>;
  start(input: {
    taskId: string;
    workspacePath: string;
    handoffArtifactId: string;
    approvedProfileId: string;
  }): Promise<{ runId: string }>;
  events(runId: string, afterSequence: number): AsyncIterable<RunnerEvent>;
  cancel(runId: string): Promise<void>;
  resume(runId: string): Promise<{ supported: boolean }>;
}
```

실제 인증·모델 목록·재개·streaming·권한 요청은 지원 capability로 노출한다. 모든 runner가 동일 기능을 제공한다고 가정하지 않는다. 표준화된 이벤트는 progress, toolActivity, candidateReady, usageReported, permissionRequired, failed, cancelled, completed다. 모델의 비공개 추론을 수집하거나 필수 로그로 요구하지 않는다.

### 12.3 연결 우선순위

- Codex: 외부 MCP 우선. 내장 job 실행은 공식 non-interactive/SDK 경로를 검증한다. App Server는 조회 문서에 실험적·프로덕션 비지원 경고가 있어 정식 핵심 의존성으로 채택하지 않는다. [S10, S11, S12]
- OpenCode: 공식 `serve`의 HTTP API를 활용하는 어댑터를 별도 구현할 수 있다. loopback bind, 서버 비밀번호, 사용자 지정 포트, 종료·session 정리를 강제한다. 원본 인증정보를 UI renderer에 노출하지 않는다. [S13]
- Claude Code: 공식 programmatic/headless 인터페이스의 JSON/stream-json을 파싱한다. CLI 텍스트 화면 scraping을 금지한다. 미지원 권한 요청은 실패/사용자 개입으로 반환하며 일괄 권한 해제 옵션으로 해결하지 않는다. [S14]

각 runner의 실제 명령 옵션은 설치 버전의 도움말과 공식 문서로 확인하고 호환 프로필에 저장한다. 모델명을 hardcode하지 않는다. 사용자가 설치한 서비스에서 확인된 provider/model ID만 사용한다.

### 12.4 비용·토큰

그리기·배치·계약 검사·geometry 계산은 토큰을 쓰지 않는다. LLM은 스타일 후보, 슬롯 구현, 기존 코드 이해, 실패 수정에 사용한다. 기본은 implementer 1개와 독립 reviewer 1개, 같은 실패 자동 수정은 최대 2회다. 스타일 후보 생성은 최대 3개이며 opt-in이다.

사용량을 provider가 실제 보고할 때만 토큰 수로 표시한다. 보고되지 않으면 `미제공`으로 표시하며 0으로 처리하지 않는다. 추정비용은 설정된 단가와 추정 여부를 표시한다. 구독형 사용량을 달러 API 비용으로 정확히 환산했다고 주장하지 않는다.

## 13. 작업·후보·승인의 상태 기계

### 13.1 상태

```text
CREATED → PREPARING → READY → IMPLEMENTING → SNAPSHOTTING → VERIFYING
                                                             │
                          ┌──────────────────────────────────┤
                          ▼                                  ▼
                     NEEDS_REPAIR                     PENDING_APPROVAL
                          │                                  │
                          └→ IMPLEMENTING                    ▼
                                                         APPLYING → APPLIED
```

모든 실행 전 상태에서 정책에 따라 CANCELLED/FAILED/STALE로 전환할 수 있다. APPLYING 도중 취소는 파일 교체를 임의 중단하지 않고 transaction 안정 지점까지 처리한 후 rollback을 제안한다. APPLIED는 과거 적용 기록이며 이후 drift가 생겨도 과거 기록을 지우지 않는다.

### 13.2 Task record

`taskId, projectId, screenId, scopeNodeIds, baseContractRevision, baseCommit, baseManifestHash, policyRevision, agentPrincipal, allowedPaths, protectedPaths, executionProfileId, state, attempt, requestId, createdAt, expiresAt, lastEventSequence`를 기록한다.

Task가 허용하는 node scope와 파일 scope는 다르다. 신규 슬롯 파일은 approved output root 아래로만 생성할 수 있다. 사용자가 선택한 node가 하나여도 공용 파일 변경 영향이 넓으면 policy 승인을 추가로 요구한다.

### 13.3 Candidate record

`candidateId, taskId, treeHash, contractHash, effectiveContractHash, layoutOverridesHash, generatorVersion, policyHash, changedFiles, dependencyLockHash, fixturesHash, verificationProfileHash, createdAt`를 포함한다. 후보가 생성된 후 수정되면 기존 candidate를 갱신하지 않고 새 candidateId를 만든다.

### 13.4 동시 작업

프로젝트 계약은 single writer, 동일 화면·공용 token을 수정하는 작업은 lease로 직렬화한다. 서로 다른 슬롯은 병렬 구현할 수 있지만 후보 통합 후 전체 영향 범위를 다시 검증한다. 각 worker가 동일 파일을 고치게 하지 않는다. 다른 task에서 온 worktree나 candidate ID를 제출하면 거절한다.

한 에이전트가 여러 화면을 생성해도 작업마다 contract revision을 고정한다. 작업 중 사용자가 계약을 바꾸면 연관 task는 STALE이다. 자동으로 최신 revision을 붙이고 기존 결과를 통과 처리하지 않는다.

### 13.5 중단·재개

프로세스 강제 종료, 네트워크 오류, 모델 한도, 사용자의 취소를 구별한다. 영속 job record는 남기고 agent run의 재개 가능 여부를 표시한다. 이미 검증한 candidate는 보존할 수 있으나 정책·계약·원본 해시가 달라졌다면 재검증한다. 절반 작성된 코드를 원본에 적용하지 않는다.

## 14. 코드 생성과 기존 저장소 통합

### 14.1 Managed React 어댑터

지원 프로필은 처음에 React/TypeScript/Vite 단일 앱, CSS Modules 또는 plain scoped CSS다. 모노레포는 사용자가 app root를 명시한다. 임의 build system·SSR·custom Babel 조합은 자동 지원하지 않는다.

컴파일러는 Contract에서 DOM 구조·layout CSS·node ID·slot types를 결정적으로 생성한다. LLM은 컴파일러가 생성할 수 있는 구조를 다시 자유롭게 생성하지 않는다. 동일 contract/token/compiler version에서 동일 출력과 source hash가 나와야 한다.

`row/column`은 flex, 명시 grid는 CSS Grid, HUD형 overlay는 relative parent와 absolute anchored child로 매핑한다. 일반 목록을 모든 좌표 absolute로 만드는 것을 금지한다. 제약이 표현 불가능하면 unsupported를 반환한다.

### 14.2 슬롯 규칙

각 슬롯은 하나의 measurement root를 가져야 하고 지정 props 계약을 준수한다. 외부 margin으로 parent geometry를 바꾸거나 global selector로 다른 슬롯을 수정하지 않는다. 복잡한 portal, shadow DOM, canvas 내부 UI는 특수 어댑터 없이는 보장 범위를 낮춘다.

기본 레이아웃 셸은 타입 안전한 slot 함수/컴포넌트를 주입받는다. `window`, `document`, runtime fixture가 프로덕션 SSR 경로에서 사용되는지 확인하지 않고 Next.js 호환을 선언하지 않는다.

### 14.3 Adopted 모드

기존 UI에 `data-boxspec-id`와 adapter mapping을 추가하는 최소 patch를 제안한다. 해당 patch도 사용자 승인 대상이다. 동적 반복 항목은 `componentDefinitionId + stableInstanceKey`로 구분한다. array index를 영속 node ID로 쓰지 않는다.

코드에서 width, layout, 부모 구조를 역추출할 수 없는 경우 `측정 기반`으로 표시한다. CSS-in-JS, 동적 class, conditional branches의 의미를 모두 추론했다고 가정하지 않는다.

### 14.4 파일 처리

AST 수정이 가능한 TS/TSX는 타입·구문 트리를 사용한다. 정규표현식으로 파일 전체를 재작성하지 않는다. UTF-8 BOM, CRLF, import 순서, 기존 formatter를 보존한다. 바이너리 파일의 patch 변경은 P1에서 금지하고 에셋 import는 별도 승인 흐름이다.

lockfile·package.json·global CSS·router·auth·store·business service는 기본 protected다. 새 의존성이 필요하면 task를 멈추고 dependency change proposal을 만든다. 패키지 설치는 arbitrary code execution 가능 작업으로 별도 취급한다.

### 14.5 Git worktree와 snapshot

Git worktree는 별도 작업 디렉터리를 관리하는 기반이다. filesystem 보안 샌드박스가 아니다. [S15]

worktree는 사용자 프로필의 짧은 로컬 경로에 만들고 원본 repo의 subdirectory에 중첩하지 않는다. LFS, submodule, monorepo symlink는 처음 연결 시 감지한다. 지원하지 않는 조합은 정식 적용을 막고 진단한다. `node_modules`를 원본과 쓰기 가능한 symlink로 공유하지 않는다.

`submit_candidate`는 allowed change manifest를 수집하고 generator-owned 파일을 재생성한다. 검증은 agent가 계속 편집하는 worktree가 아니라 별도 snapshot에서 수행한다. 검증 시작·종료와 승인 시 snapshot 해시를 재확인한다. agent가 snapshot을 직접 수정해도 같은 hash로 통과시키지 않는다.

## 15. 실제 렌더링 검증

### 15.1 검사 순서

1. JSON schema와 semantic contract validation.
2. 변경 경로·소유권·hard policy·dependency change 검사.
3. 결정적 generator output 검사와 컴파일러 golden tests.
4. 타입 검사·build·기존 핵심 UI 테스트.
5. 승인 fixture로 실제 페이지 실행.
6. node mapping·DOM rect·computed style·scroll/clip 수집.
7. 관계 제약·수치 규칙·접근성·핵심 상호작용 검사.
8. screenshot baseline 비교와 보호 영역 회귀 검사.
9. 선택적 AI 시각 리뷰.
10. evidence hash와 report를 봉인하고 검토 가능 여부 결정.

하나라도 필수 검사가 실행되지 않으면 PASSED가 아니라 `UNVERIFIED` 또는 `BLOCKED`다. AI 리뷰의 “좋아 보임”으로 build 실패·가림·레이아웃 위반을 상쇄하지 않는다.

### 15.2 실제 측정

Web은 node root의 `getBoundingClientRect()`, computed style, visibility, clipping ancestor, scroll size, hit-test, role/label을 수집한다. `display:none` 노드가 0×0으로 측정됐다고 geometry pass 처리하지 않는다. visibility는 별도 규칙으로 검사한다.

좌표는 viewport document 기준 CSS px로 정규화하고 scroll offset을 기록한다. iframe·portal은 좌표 공간 변환이 검증된 경우에만 검사한다. transform된 rotated UI는 axis-aligned rect만으로 충분하지 않으므로 P1 Managed에서 회전 layout을 지원하지 않는다.

독립 validator는 agent가 제출한 expected 값을 사용하지 않고 승인 Contract에서 규칙을 읽는다. 측정 스크립트·정책·검증 fixture는 candidate에서 임의 수정할 수 없는 신뢰 패키지/승인 snapshot을 사용한다.

### 15.3 수치 판정

예를 들어 `abs(actual.width - 260) <= 1`이면 fixed-width assertion 통과다. 1은 CSS px로서 screenshot physical pixel과 다르다. 오른쪽 배치 검사에는 `abs(main.left - sidebar.right - expectedGap) <= tolerance` 같은 관계를 쓴다.

no-overlap은 비교 대상 영역과 허용 관계를 명시한다. 부모·자식 포함, tooltip, 승인된 overlay는 일반 충돌로 세지 않는다. 문자열 overflow는 scrollWidth 비교만으로 끝내지 않고 multiline, line-clamp, 허용 truncation policy를 구분한다.

### 15.4 상태·뷰포트 매트릭스

기본 화면 fixture는 populated, empty, loading, error, long-text다. 화면에 실제로 적용 가능한 상태만 선택하며 삭제한 필수 상태는 승인 없이 무시하지 못한다. query·button·navigation 시나리오는 binding 계약에서 생성한다.

예시 Web viewports: 1440×900, 1280×720, 768×1024, 390×844. breakpoint 768이 있다면 767/768/769 폭을 추가한다. DPR 1/2 및 사용자 기본 텍스트 확대를 별도 검사한다. 실제 지원 매트릭스는 프로젝트에서 승인하고 report에 그대로 기록한다.

Unity와 Android는 각각 별도 renderer와 좌표 정규화를 사용한다. 웹 screenshot으로 모바일 네이티브/Unity가 검증됐다고 주장하지 않는다.

### 15.5 스크린샷 신뢰성

시간, 랜덤 seed, locale, timezone, fixture data, viewport, browser version, font availability를 고정한다. 애니메이션·캐럿·외부 이미지는 승인된 capture profile로 안정화한다. 폰트와 이미지 로딩 완료를 확인하고 일정 횟수 안에 안정화되지 않으면 실패로 보고한다.

Playwright의 시각 비교는 플랫폼·브라우저·폰트에 영향을 받는다. baseline은 OS/browser/font/profile 조합별로 관리한다. [S16]

스타일 변경이 허용된 영역은 픽셀 차이만으로 실패시키지 않는다. 반대로 전체 스크린샷 차이가 작아도 작은 중요한 버튼이 사라지면 semantic/interaction 검사로 실패해야 한다. baseline 업데이트는 사용자 승인 없이는 금지한다. 새로운 baseline이 만들어졌다고 자동 통과로 처리하지 않는다.

### 15.6 결과 표기

| 결과 | 의미 |
|---|---|
| PASS | 선택된 profile의 필수 검사가 모두 통과 |
| FAIL | 실행된 검사에서 위반 발견 |
| UNVERIFIED | 증거 또는 지원 기능 부족 |
| ERROR | 실행 환경·도구 오류 |
| STALE | 계약·정책·후보·원본 중 하나가 변경됨 |

`모든 경우에서 UI가 절대 안 깨짐`이 아니라 **명시한 계약·상태·뷰포트의 검증을 통과**했다고 표시한다. 미검증 상태를 통과율 분모에서 몰래 빼지 않는다.

## 16. 공간 diff와 리뷰

검토 패널은 구조 변경, 스타일 변경, 콘텐츠 변경, 바인딩 변경, 코드 변경을 분리한다. 화면에서는 기준 윤곽·후보 윤곽·이동 벡터·위반 위치를 볼 수 있다. 선택 node 클릭 시 관련 파일 diff와 검사 증거를 함께 보여준다.

`Approve`는 특정 candidate hash + contract revision + report ID + policy revision에 대한 승인이다. 사용자 승인 후 새로운 candidate가 생기면 승인 재사용을 금지한다. 부분 승인도 가능하지만 승인 subset으로 새 candidate를 만들고 dependency closure를 다시 검증한다. 통과한 전체 후보에서 파일 몇 개만 골라 적용해도 통과라고 가정하지 않는다.

변경 요청이 hard를 건드리는 경우 실행 버튼 대신 `구조 변경 승인 필요`를 표시한다. 기존 구조를 유지한 대안과 구조 변경 대안을 분리한다. 사용자가 거절하면 해당 proposal을 기록하고 같은 수정 루프에서 반복 강요하지 않는다.

## 17. Unity uGUI 어댑터 — 후속 구현 명세

### 17.1 초기 지원 범위

Unity의 승인된 정확한 Editor 버전, uGUI, TextMeshPro 설치, Screen Space Overlay Canvas, RectTransform 기반 HUD, 생성 prefab을 첫 범위로 한다. UI Toolkit·world-space UI·VR·커스텀 렌더 파이프라인 특수 HUD는 별도 프로필이다.

현재 프로젝트의 `ProjectVersion.txt`와 package manifest를 읽어 실제 버전을 결정한다. 문서상 `Unity 6 지원`이라는 넓은 표기만으로 모든 minor 버전을 지원했다고 하지 않는다.

### 17.2 구현 구조

Unity Editor 패키지 `com.boxspec.editor`를 이 프로젝트에서 만든다. 승인 contract를 JSON으로 읽고 Editor main thread에서 순차 command를 실행한다. Core는 인증된 loopback 전용 bridge와 job 상태로 통신한다. arbitrary C# eval API를 만들지 않는다.

주요 동작은 `inspect_scene`, `list_ui_assets`, `create_or_update_managed_prefab`, `capture_layout`, `capture_game_view`, `run_ui_scenarios`다. 이 동작은 내부 adapter API이며 외부 에이전트에 unrestricted Editor execute 권한으로 노출하지 않는다.

### 17.3 RectTransform 매핑

계약 좌표는 top-left, Unity 측정은 canvas logical unit으로 정규화한다. anchorMin/anchorMax, pivot, anchoredPosition, sizeDelta를 adapter에서 변환한다. Unity RectTransform API가 제공하는 anchor·pivot·size 정보를 사용한다. [S17]

고정 HUD 사각형의 단순 top-left 프로필은 anchors/pivot을 top-left에 두고 y를 변환한다. stretch와 fill은 다른 매핑이 필요하므로 모든 node에 같은 공식 하나를 적용하지 않는다. LayoutGroup이 제어하는 RectTransform은 동시에 직접 sizeDelta를 강제하지 않는다.

LayoutGroup, ContentSizeFitter, CanvasScaler가 geometry를 변화시키는 것을 고려한다. 렌더 측정 전 Canvas update와 레이아웃 안정화를 수행한다. Canvas update API 사용만으로 모든 비동기 텍스트·애니메이션이 안정됐다고 가정하지 않는다. [S20]

### 17.4 에셋·씬 보호

AssetDatabase와 PrefabUtility 등 Editor API로 저장하며 prefab/scene YAML을 LLM이 무작위 문자열 편집하는 방식을 기본으로 삼지 않는다. PrefabUtility는 prefab 편집·저장의 공식 기반으로 사용한다. [S21]

managed prefab 안의 구조만 수정한다. 기존 게임 로직은 MonoBehaviour reference와 UnityEvent binding으로 연결한다. `.meta` GUID를 재생성해 기존 참조를 끊지 않는다. 저장·경제·자원·건설·시간 로직은 protected다.

기존 씬 적용은 staging clone에서 생성한 prefab과 검증 evidence를 먼저 확보한다. 원본 Unity Editor가 열린 상태에서는 외부 파일을 바로 덮어쓰지 않고 Editor bridge가 실행 중 상태·미저장 씬·domain reload를 확인한 뒤 승인 transaction을 처리한다. 미저장 씬은 자동 저장/폐기하지 않는다.

### 17.5 검증과 성능

Game View 1920×1080, 1280×720 및 프로젝트가 실제 지원하는 종횡비에서 RectTransform corner, CanvasScaler 결과, 텍스트 overflow, 버튼 raycast, modal input blocking, navigation을 검사한다. 월드가 UI 때문에 과도하게 가려지지 않는 보호 영역을 지정할 수 있다.

Unity 재컴파일·asset import·domain reload는 느릴 수 있으므로 매 노드 변경마다 Editor를 새로 시작하지 않는다. live preview와 신뢰용 고정 검증 실행은 분리하고 동일한 결과라고 주장하지 않는다. 한 Unity instance의 command는 직렬 실행한다.

## 18. React Native Android 어댑터 — 후속 구현 명세

타깃은 React Native Android 프로젝트와 지정한 emulator/device 조합이다. React Native Web 결과는 네이티브 검증이 아니다. 프로젝트 버전·architecture·Expo 여부·사용 중인 navigation/gesture 패키지를 프로필에 기록한다.

View의 `testID`, `onLayout` 및 타깃 환경에서 검증한 실제 window 좌표 측정을 연결한다. onLayout은 부모 상대 좌표이므로 화면 전체 위치로 오인하지 않는다. measurement node의 flattening·collapsable 동작과 안정적인 identity를 시험한다. View API는 이러한 구현의 기본 참조다. [S22]

좌표 단위 dp, density, status/navigation bar, safe area, 키보드, 폰트 스케일을 별도 기록한다. Android emulator에서 capture·interaction adapter를 구현하고 화면이 실행되지 않으면 UNVERIFIED다. 비밀번호·실제 계정 데이터 대신 fixture를 사용한다.

existing React Native 앱의 리디자인에서는 store/hook/navigation·API 계약을 유지한다. StyleSheet와 등록된 공용 컴포넌트 위주로 바꾸고 화면 이동 방식을 임의로 새로 만들지 않는다. Compose와 React Native는 서로 다른 어댑터이며 같은 것으로 취급하지 않는다.

## 19. 보안·개인정보·실행 신뢰

### 19.1 위협 모델

방어 대상은 실수한 에이전트, 악성 prompt가 들어 있는 README/화면 문구, 권한 범위를 벗어난 MCP 요청, 악성 preview JavaScript, 경로 우회, 잘못된 후보 적용, 공급망 업데이트 변조다. 동일 사용자 권한의 악성 agent·운영체제 관리자·악성 커널에 대한 완전한 격리는 보장하지 않는다.

### 19.2 Preview와 에디터의 경계

에디터 UI는 패키징된 trusted asset만 로드한다. `nodeIntegration:false`, `contextIsolation:true`, renderer sandbox, 좁은 preload API, IPC sender 검증을 적용한다. 생성된 앱은 trusted editor DOM 또는 Node 권한이 있는 창 안에서 실행하지 않는다. Electron 공식 보안 지침을 기반으로 구현한다. [S08]

P1 기본 미리보기는 별도 browser process의 결과를 캡처해 표시한다. interactive preview는 별도 비권한 context에서만 연다. candidate가 외부 주소를 열거나 팝업·파일 다운로드·OS 권한을 요청하는 것을 기본 거절한다. screenshot 비교 화면은 렌더 결과이지 HTML code 삽입 영역이 아니다.

### 19.3 실행 권한

프로젝트 build, Vite config, package lifecycle script, Unity Editor package는 코드 실행이다. 사용자가 승인한 프로젝트만 실행한다. worktree는 보안 격리가 아니므로 “안전하게 아무 저장소나 실행”이라고 표시하지 않는다.

실행 프로필은 executable의 확인된 경로, argv 배열, cwd, timeout, 환경 변수 allowlist, 네트워크 의도를 고정한다. MCP 입력에 shell 문자열을 받지 않는다. Windows `.cmd` launcher와 quoting은 전용 테스트를 갖고 임의 사용자 문자열을 `cmd /c`에 이어붙이지 않는다.

OS 수준 네트워크 차단·filesystem isolation을 제공하지 않는 프로필에서는 이를 제공하는 것처럼 `network denied`라고 표시하지 않는다. browser request 차단과 child process 전체 network 차단은 다르다. 강한 격리는 별도 container/VM integration으로 추가하며 P1의 필수 환경으로 강요하지 않는다.

### 19.4 경로·파일 안전

relative path만 받고 canonical path 및 각 ancestor의 symlink/junction/reparse point를 확인한다. `..`, 절대 경로, UNC, device path, alternate data stream, 예약 device 이름, 대소문자 충돌을 방어한다. 신규 파일은 가장 가까운 존재 ancestor를 검사하고 쓰기 직전에 다시 확인한다.

.git, .env, key/cert, 사용자 홈, 앱 credentials, 런타임 정책, 검증 baseline은 agent patch에서 보호한다. 단순 문자열 prefix 비교로 `C:/project2`를 `C:/project` 하위로 허용하지 않는다. binary와 oversized file은 별도 처리한다.

### 19.5 Prompt injection

프로젝트 README, 이미지 속 텍스트, 에셋 이름, 코드 주석은 명령이 아니라 untrusted project data다. 컨텍스트에 출처·trust level을 붙이고, 이 데이터가 `잠금 해제`, `외부 업로드`, `정책 수정`을 시키더라도 Core가 거절한다. 시스템 프롬프트만으로 prompt injection을 해결했다고 주장하지 않는다.

### 19.6 개인정보

기본 프로젝트 데이터와 screenshots는 로컬 저장이다. 외부 에이전트의 모델에 전달하는 contract·source excerpt·screenshot 범위를 사용자에게 보여준다. 민감한 파일은 기본 제외, screenshot의 실제 데이터·개인정보는 fixture나 마스킹을 권장한다.

제품 analytics는 opt-in, 원문 코드·프롬프트·스크린샷은 기본 수집 금지다. 진단 bundle은 secrets redaction 미리보기 후 저장·공유한다. 에이전트 로그인 파일이나 API key를 찾거나 추출하는 기능을 만들지 않는다.

### 19.7 Remote MCP

P1은 local only다. 원격 모드가 필요해지면 별도 위협 모델·HTTPS·권한 검증·Origin 검사·tenant 경계·공식 authorization 규격을 갖추고 출시한다. 인증 없이 `0.0.0.0`에 개발 서버를 여는 우회법을 제품 기본값으로 쓰지 않는다.

## 20. 비기능 요구와 운영 목표

아래는 목표값이며 초기 벤치마크로 조정한다. UI freeze와 데이터 손실은 기능 수보다 우선한다.

| 항목 | 목표 | 측정 조건 |
|---|---|---|
| 드래그 반응 | p95 frame ≤ 20ms | 보이는 node 200개, total 2,000개, reference laptop |
| 선택·속성 변경 | p95 ≤ 100ms | LLM/빌드 제외 |
| 계약 열기 | p95 ≤ 2초 | 2,000 node, 이미지 원본 제외 |
| MCP context 조회 | p95 ≤ 300ms | Core cache hit, bounded node slice |
| autosave 확인 | command 종료 후 500ms 이내 목표 | disk 정상, fsync 완료 후 상태 변경 |
| 편집기 idle 메모리 | ≤ 500MiB 목표 | preview/browser/agent 제외, 실제 측정 |
| resource 상한 | 프로젝트 node 10,000 hard cap | 초과는 명시 오류; 대규모 지원은 후속 |
| 자동 수정 | 실패별 최대 2회 기본 | 같은 violation signature 반복 시 조기 정지 |
| 작업 동시성 | 한 프로젝트 구현 2개, 검증 browser 1개 기본 | 조정 가능; 사용자 PC 부하 기준 |

reference machine은 개발 시 실제 기기 사양을 기록한다. 특정 사용자의 노트북에서 달성했다고 벤치마크 없이 주장하지 않는다. 노트북에서는 지속 화면 AI 분석이나 대형 local model을 기본 실행하지 않는다.

이벤트 로그는 task/node/candidate/report/request ID로 연결한다. usage와 latency를 분리하여 기록한다. `unknown usage`를 0으로 집계하지 않는다. 기본 로그 보존 목표 14일, candidate artifacts 7일·디스크 quota 5GiB는 사용자 변경 가능하다. pinned baseline·승인 journal은 일반 TTL 정리 대상이 아니다.

## 21. 코드 저장소 구조와 모듈 경계

```text
boxspec/
  apps/
    desktop/                # Electron main/preload/editor
    mcp/                    # stdio bridge entry
    cli/                    # doctor/validate/export, privileged writes 없음
  packages/
    contracts/              # schemas, types, migrations
    core/                   # domain services, single writer
    editor-domain/          # commands, selection, snap, undo
    layout-engine/          # semantic validation, canonicalization
    compiler-web/           # deterministic shell generation
    project-index/          # components/assets/bindings
    change-manager/         # git, snapshots, apply journal
    verifier-web/           # rendering + independent rule checks
    agent-runner/           # common interface
    runner-codex/           # optional capability-gated adapter
    runner-opencode/
    runner-claude/
    adapter-unity/          # P2 after P1; editor package 별도 하위 디렉터리
    adapter-rn-android/      # P3
    shared-ui/              # editor design system, not target UI
  fixtures/
    react-dashboard/
    protected-logic/
    adversarial-paths/
    unicode-paths/
  tests/
    unit/
    contract/
    integration/
    e2e/
    security/
    compatibility/
  docs/
    adr/
    compatibility.md
    runbooks/
```

순수 domain package는 Electron, React, MCP SDK를 import하지 않는다. `core`의 use case를 IPC와 MCP가 공유하고 정책을 각 entry에서 복제하지 않는다. adapter package는 contract schema를 확장할 수 있지만 unknown capability를 무시하지 않는다.

### 21.1 핵심 내부 인터페이스

```ts
interface LayoutCompiler {
  capabilities(): TargetCapabilities;
  validate(contract: LayoutContract): Diagnostic[];
  compile(input: CompileInput): GeneratedManifest;
}

interface RenderVerifier {
  verify(input: FrozenCandidateInput): Promise<VerificationReport>;
}

interface ProjectAdapter {
  detect(root: ApprovedProjectRoot): Promise<DetectionResult>;
  inspect(input: InspectionInput): Promise<ProjectInventory>;
  prepare(input: ApprovedTaskInput): Promise<WorkspaceHandle>;
  collect(input: CollectCandidateInput): Promise<CandidateManifest>;
}

interface ChangeManager {
  prepareApply(input: ApprovedCandidateInput): Promise<ApplyPlan>;
  apply(input: ConfirmedApplyPlan): Promise<ApplyResult>;
  recover(transactionId: string): Promise<RecoveryResult>;
}
```

타입 이름은 구현 대상 계약이다. 실제 타입 파일에는 nullability, exhaustive union, 오류 종류와 cancellation을 명시한다. `any`로 도구 입력을 받지 않는다.

## 22. 구현 백로그와 완료 증거

기간 추정보다 의존성과 통과 기준으로 진행한다. 아래 각 task는 재현 가능한 증거가 있어야 닫는다.

| ID | 작업 | 의존 | 완료 증거 |
|---|---|---|---|
| B00 | 환경·버전·라이선스 조사, monorepo | 없음 | exact lockfile, Windows install/build, compatibility 문서 |
| B01 | schema/types/semantic validation | B00 | valid/invalid fixtures, cycle·reference·breakpoint 검사 |
| B02 | command store/revision/undo/recovery | B01 | crash replay와 중복 command tests |
| B03 | 최소 canvas/inspector | B01,B02 | draw/label/reparent/lock/save/reopen E2E |
| B04 | deterministic web compiler | B01 | byte-stable golden output, flex/grid/overlay fixtures |
| B05 | core project grant/paths | B01 | traversal·junction·protected path negative tests |
| B06 | MCP bridge 3-client 설정·진단 | B01,B05 | 실제 client context read, malformed request 거절 |
| B07 | task worktree/snapshot | B02,B05 | 원본 무변경, dirty baseline 중단, candidate hash |
| B08 | React slot generation workflow | B04,B06,B07 | 실제 에이전트가 새 슬롯 구현 |
| B09 | render/geometry/interaction verifier | B04,B07 | 의도적으로 틀린 width·overlap·missing button 검출 |
| B10 | candidate/report/review state machine | B08,B09 | agent 완료 발언과 무관한 fail/pass |
| B11 | apply journal/rollback | B10 | 파일 교체 중 crash, 사용자 변경 충돌 복구 |
| B12 | spatial diff/style tokens/assets | B03,B10 | 선택 scope·토큰 revision·썸네일 검수 |
| B13 | adopted mode/regression | B09,B12 | existing app 보존 + 공용 컴포넌트 영향 검사 |
| B14 | 에러 UX/IME/DPI/성능 | B03–B13 | 한글·125/150/200%·cold restart·memory evidence |
| B15 | installer/sign/update/uninstall | B14 | clean VM 설치·업데이트·복구, 무단 프로젝트 삭제 없음 |
| B16 | 전체 보안·호환·파일럿 gate | B15 | 아래 출시 체크리스트 모두 통과 |
| B17 | managed runner adapters | B10,B16 또는 격리 beta | 실제 설치 CLI별 start/events/cancel + 권한 거절 |
| B18 | Unity uGUI P2 | B16 | Editor 실제 prefab/render/interaction/원본 복구 |
| B19 | React Native Android P3 | B16 | 실제 emulator dp/keyboard/state/interaction |

B03을 꾸미느라 B04–B11을 미루지 않는다. 첫 번째 성취는 예쁜 툴바가 아니라 **사이드바 잠금을 어긴 실제 코드가 검증에서 실패하고 원본에 적용되지 않는 것**이다.

## 23. 에이전트로 이 제품을 개발하는 방식

제품 사용 시 agent workflow와, BoxSpec 자체를 개발하는 multi-agent workflow를 혼동하지 않는다.

### 23.1 개발 역할

총괄 에이전트는 요구·ADR·인터페이스·통합을 관리한다. worker는 contract/core, editor, MCP/integration, verifier/change-manager로 분리한다. reviewer는 구현 담당과 분리하고 failed cases와 정책 우회를 우선 찾는다.

동시 worker 기본 3개, 같은 파일 writer는 1개다. `.contracts` 또는 API 변경은 총괄이 승인하고 dependent worker에게 새 revision을 알린다. 생성한 subagent를 사용하지 않았는데 “여러 에이전트가 검증”했다고 보고하지 않는다. 실제 사용한 tool/model/command만 작업 로그에 남긴다.

### 23.2 실행 규칙

먼저 기존 repo를 조사한다. 기존 프로젝트가 있으면 새 scaffold로 덮어쓰지 않는다. 문서를 읽고 모듈 경계와 release scope를 고정한다. 선택 이유가 있는 결정을 바꾸려면 ADR을 쓴다. 실제 doc/API와 예제의 버전 차이를 확인한다.

모의 MCP response·정적 screenshot·hardcoded pass로 production 기능을 대체하지 않는다. unit test double은 허용하되 E2E에서 실제 render와 actual client를 사용한다. 테스트를 실행할 수 없는 환경이면 그 이유와 미검증 항목을 기록하고 완료로 닫지 않는다.

상세 kickoff는 `agent/BUILD_AGENT_PROMPT.md`, 지속 규칙은 `agent/AGENTS.md`, 이 제품을 사용하는 agent용 지시는 `agent/USE_BOXSPEC_PROMPT.md`에 둔다.

## 24. 테스트 전략과 출시 차단 기준

### 24.1 계약·엔진 테스트

같은 계약에서 동일 output/hash, 부모 순환, 없는 node, duplicate IDs, 겹친 breakpoint, gap negative, incompatible sizing, hard 변경, soft 범위 경계, ancestor 변경 우회, unsupported target capability를 검사한다. schema-valid가 semantic-valid를 의미하지 않는 negative fixture가 필수다.

### 24.2 원본 보호 테스트

dirty Git baseline, 새 untracked file, original HEAD 변경, apply 중 crash, low disk, locked file, antivirus 경합, CRLF/BOM, 한글·공백 경로, junction/symlink, 후보 제출 후 수정, 승인 이후 다른 후보로 교체, protected file 삭제를 포함한다.

### 24.3 MCP 테스트

실제 3개 client 각각에서 connect/read/start/submit/verify/report/cancel을 시험한다. stdout 로그 오염, app 미실행, 두 bridge, revoked grant, 오래된 revision, 중복 requestId, foreign taskId, oversized patch, unknown tool/field, client image capability 없음, timeout/disconnect를 검사한다.

### 24.4 렌더링 테스트

260px 고정 sidebar를 320px로 바꾼 후보는 실패한다. width 텍스트가 유지돼도 global transform으로 위치를 바꾸면 실패한다. hidden node·0×0·font missing·button behind overlay·overflow clipped·empty fixture·error state·공용 컴포넌트 다른 화면 회귀를 검출한다.

### 24.5 출시에 필요한 실제 증거

- 실제 설치형 앱에서 전체 수직 흐름 완주 영상/스크린샷과 command 로그.
- 최소 3개 실제 소형 React 프로젝트, 각각 최소 3개 화면, 3개 MCP client의 호환 시험.
- 고정 구조 위에서 연속 20회 수정 요청 시 hard 위반 후보가 원본 적용으로 넘어가지 않음.
- 검증 failure/timeout/unknown이 잘못 PASS로 바뀌는 경우 0건.
- 후보·report·승인·적용 해시 연결과 중간 crash 복구 시험.
- 한글 입력, 고해상도 배율, 실행 권한 거절, 연결 실패 UX 점검.
- 독립 reviewer의 보안·권한 검토와 모든 blocking 이슈 해결.

프로젝트 수·수정 횟수는 출시 평가를 위한 최소 목표이지 현재 테스트 완료 수치가 아니다.

## 25. 패키징·업데이트·운영

Windows 설치 파일은 선택한 Electron packager/updater 조합으로 서명한다. 런타임·bridge launcher·검증 browser의 버전과 license notice를 함께 관리한다. 사용자 시스템의 임의 Node 경로를 신뢰하지 않는다.

자동 업데이트는 manifest와 실행 파일의 신뢰 검증, stable/beta channel 분리, 실패 시 이전 실행 가능 버전 복구, schema migration 전 백업을 갖춘다. 업데이트 방식은 선택한 packager와 맞춰 실제 시험하며 Electron 업데이트 문서를 참조한다. [S23]

browser binary는 크기가 클 수 있으므로 설치 시 포함 또는 검증된 first-run download를 선택한다. 다운로드 실패·오프라인에서는 편집·계약 저장은 유지되고 검증만 unavailable이다. 필요한 바이너리를 조용히 받다가 앱 전체가 멈추면 안 된다.

uninstall은 사용자 프로젝트·Git repo·승인 contract를 삭제하지 않는다. 사용자 프로필 cache 삭제는 별도 확인이다. 진단 명령은 `doctor`로 설치 경로, bridge/core, grants, browser, Git, adapter, agent executable 상태를 redacted JSON으로 출력한다.

### 25.1 Runbook

- **MCP 연결 실패:** config 작성 성공과 실제 호출 성공을 구분 → 절대 경로·프로세스·stdout·grant·protocol 확인.
- **검증 flaky:** fixture/profile/browser/font/animation 차이를 확인 → baseline 무단 갱신 금지.
- **적용 중 crash:** journal로 before/after/unknown 파일 분류 → unknown은 사용자 선택 없이 덮어쓰기 금지.
- **agent budget 초과:** 새 후보 생성 중단 → 기존 candidate/evidence 보존 → 원본 자동 적용 금지.
- **소스 drift:** 관계 task stale → 비교·재기준 설정 승인 → 새 검증.

## 26. 제품 지표와 사업 검증

초기에는 수익 모델보다 반복 UI 수정의 안정성을 검증한다. 측정 후보는 최초 useful contract까지 걸린 조작 수, 사용자 재배치 횟수, hard 위반 검출률, 실제 적용 후 되돌림률, 기존 컴포넌트 재사용률, 수정 1건당 verifier 실행·agent usage다.

사용자 인터뷰에는 “한 번 생성이 멋진가”보다 “열 번째 수정에서도 유지되는가”, “설정이 텍스트 설명보다 덜 귀찮은가”, “기존 프로젝트 연결 비용이 가치보다 큰가”를 묻는다.

후보 과금은 local editor/MCP core와 고급 adapter·team policy 기능을 분리하는 구조다. 가격과 유료화 범위는 실사용 검증 후 결정한다. 구독 AI 비용을 BoxSpec 사용료에 포함했다고 오해하게 만들지 않는다. `수백만 토큰 소비` 자체를 제품 성공 지표로 삼지 않는다.

## 27. 위험과 대응

| 위험 | 실패 징후 | 대응 |
|---|---|---|
| 디자인 도구가 너무 복잡해짐 | 박스 하나에 설정 20개 요구 | 3개 기본 질문, 상세 속성 접기 |
| 구조를 잠그면 UI가 답답해짐 | 고정 좌표로 모든 화면 생성 | 관계·breakpoint·허용 범위 기반 계약 |
| AI가 셸을 우회 | global CSS/transform/overflow 악용 | 경로 보호 + actual geometry + regression |
| 기존 앱 통합 비용이 큼 | 다수 router/store 재작성 요구 | Managed isolated route와 Adopted 명확히 분리 |
| 잘못된 pass | 미검증 상태 숨김 | PASS/FAIL/UNVERIFIED/ERROR/STALE 구분 |
| 토큰·빌드 비용 폭증 | 같은 오류 무한 반복 | signature 기반 정지·수정 횟수·동시성 상한 |
| MCP/CLI 변화 | 설정은 생성되지만 호출 실패 | version detection·actual smoke test·호환 매트릭스 |
| 손그림 인식에 집착 | geometry 엔진 전에 vision 개발 | structured canvas 우선, vision 입력 후속 |
| Unity/RN 확장 과욕 | 웹도 실행 안 되는데 3 adapter | P1 gate 완료 후 target별 정식 승격 |
| 원본 유실 | 자동 stash/reset/overwrite | clean baseline·journal·conflict stop |

## 28. 첫 시연 시나리오 — 반드시 구현

1. Windows에서 BoxSpec을 설치하고 실행한다.
2. 제공된 React dashboard fixture를 승인 프로젝트로 연결한다.
3. 헤더 64, sidebar 260, main fill의 박스 구조를 만든다.
4. Sidebar 폭·topology hard, main 내부 presentation free로 저장한다.
5. 실제 Codex 또는 OpenCode로 `선택 main에 프로젝트 목록을 구현`을 실행한다.
6. 에이전트가 context revision을 읽고 worktree에 슬롯을 구현한다.
7. 실제 Vite 앱을 browser에서 렌더하고 geometry·검색 click 테스트를 통과한다.
8. 공간 diff를 확인하고 사용자 승인 후 원본에 반영한다.
9. 다른 에이전트로 `목록에 필터를 추가`하고 같은 구조 유지 결과를 확인한다.
10. 의도적으로 sidebar 320px 후보를 제출한다. verifier가 실패시키고 원본이 그대로임을 확인한다.
11. 승인 직전 원본 파일을 사용자가 편집한다. 적용이 중단되고 conflict가 표시돼야 한다.
12. 정상 후보의 적용 도중 프로세스를 강제 종료하고 복구 흐름을 재현한다.

이 시나리오를 통과한 뒤에만 “에이전트가 UI 구조를 유지하며 구현하는 도구”라는 제품 설명을 사용한다.

## 29. 문서·기계 명세의 우선순위

보안 불변식·사용자 승인 보호는 어떤 편의 예제보다 우선한다. 핵심 JSON 데이터 형태는 동봉 schema, API shape는 `mcp-tools.json`, 의미·상태·소유권은 본 기획서를 따른다. 충돌을 발견하면 조용히 한쪽을 무시하지 않고 ADR과 스키마 변경으로 해결한다.

동봉 validation script는 schema 및 몇 가지 정적 예제를 검증하는 도구일 뿐이다. 앱, compiler, MCP wire 호환성, browser renderer, 보안 통제가 구현됐다는 증거가 아니다.

## 30. 공식 근거·확인 메모

확인일은 모두 2026-09-22다. 아래 문서는 외부 인터페이스의 근거이며 본 기획의 제품 기능을 이미 구현해주는 것은 아니다. URL은 개발자가 원문을 확인할 수 있도록 코드 형태로 기록한다. 설치 시 버전별 차이를 다시 확인한다.

| ID | 출처 | 이 설계에서 확인한 범위 |
|---|---|---|
| S01 | MCP 2026-07-28 specification/transport overview | MCP 역할, stdio/HTTP와 버전별 transport 의미 |
| S02 | 공식 MCP TypeScript SDK 저장소 | 조회 시 v2 split packages·지원 규격; 안정 API는 설치 버전으로 고정 |
| S03 | OpenAI Codex MCP | local stdio, config.toml, project trust·연결 설정 |
| S04 | Claude Code MCP | stdio command, .mcp.json, 승인·scope |
| S05 | OpenCode MCP servers | local command 배열, 환경·enable 구성 |
| S06 | MCP tools | structuredContent/outputSchema/image/text fallback |
| S07 | MCP resources | 문맥 URI·resource 제공 |
| S08 | Electron security | context isolation, sandbox, Node 비활성, IPC 경계 |
| S09 | Electron utilityProcess | 코어 프로세스 분리 API |
| S10 | OpenAI Codex App Server | 프로그램 통합 인터페이스와 문서의 실험/지원 경고 |
| S11 | OpenAI Codex non-interactive | 프로그램 실행 경로 |
| S12 | OpenAI Codex SDK | 작업 자동화용 SDK 경로 |
| S13 | OpenCode server | serve HTTP API, loopback, password, OpenAPI |
| S14 | Claude Code headless | programmatic JSON/stream-json |
| S15 | Git worktree | linked working tree 관리 |
| S16 | Playwright visual comparisons | screenshot regression과 환경 차이 |
| S17 | Unity RectTransform | anchor·pivot·size·position API |
| S18 | MCP stdio | stdio framing과 lifecycle |
| S19 | MCP versioning | 세대 간 호환 처리 |
| S20 | Unity Canvas.ForceUpdateCanvases | 캔버스 update API |
| S21 | Unity PrefabUtility | Editor prefab 작업 API |
| S22 | React Native View | testID/onLayout/measurement 관련 기본 API |
| S23 | Electron updates | 패키징별 update 통합 |

```text
S01 https://modelcontextprotocol.io/specification/2026-07-28
    https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
S02 https://github.com/modelcontextprotocol/typescript-sdk
S03 https://developers.openai.com/codex/mcp/
S04 https://code.claude.com/docs/en/mcp
S05 https://opencode.ai/docs/mcp-servers/
S06 https://modelcontextprotocol.io/specification/2026-07-28/server/tools
S07 https://modelcontextprotocol.io/specification/2026-07-28/server/resources
S08 https://www.electronjs.org/docs/latest/tutorial/security
S09 https://www.electronjs.org/docs/latest/api/utility-process
S10 https://developers.openai.com/codex/app-server/
S11 https://developers.openai.com/codex/noninteractive/
S12 https://developers.openai.com/codex/sdk/
S13 https://opencode.ai/docs/server/
S14 https://code.claude.com/docs/en/headless
S15 https://git-scm.com/docs/git-worktree
S16 https://playwright.dev/docs/test-snapshots
S17 https://docs.unity3d.com/6000.0/Documentation/ScriptReference/RectTransform.html
S18 https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
S19 https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
S20 https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Canvas.ForceUpdateCanvases.html
S21 https://docs.unity3d.com/6000.0/Documentation/ScriptReference/PrefabUtility.html
S22 https://reactnative.dev/docs/view
S23 https://www.electronjs.org/docs/latest/tutorial/updates
```

---

**제품의 본질:** AI에게 “레이아웃 바꾸지 마”라고 부탁하는 편집기가 아니라, 사용자가 정한 구조를 명세로 만들고 실제 구현·검증·승인을 그 명세에 묶는 개발 도구.
