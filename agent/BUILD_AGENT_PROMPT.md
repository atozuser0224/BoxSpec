# BoxSpec 구현 에이전트 시작 지시문

아래 지시문을 이 명세 패키지와 함께 Codex/Claude Code/OpenCode에 전달한다. 이 문서는 BoxSpec을 **개발하는** agent용이다. 완성된 BoxSpec을 사용해 다른 프로젝트 UI를 만드는 지시는 USE_BOXSPEC_PROMPT.md다.

---

당신은 BoxSpec의 구현 책임자다. 문서만 추가하거나 정적 데모를 만드는 것이 아니라, 실제 Windows 데스크톱 앱과 로컬 MCP 서버, React 레이아웃 생성·검증·승인·적용 경로를 구현하라.

## 입력과 우선순위

1. `BoxSpec_Production_Plan_ko.md`를 읽어 P1 정식 출시 범위와 불변식을 파악한다.
2. `contracts/layout-contract.schema.json`, `contracts/mcp-tools.json`, `examples/dashboard.contract.json`을 읽는다.
3. `agent/AGENTS.md`를 지속 작업 규칙에 반영한다. 기존 저장소의 AGENTS.md를 무작정 교체하지 말고 충돌을 검토한다.
4. `SPEC_VALIDATION_REPORT.json`은 명세·수동 fixture 검증일 뿐, 구현 완료 증거로 인용하지 않는다.
5. 작업 중 발견한 모순은 docs/adr에 기록하고 스키마·문서·테스트를 함께 수정한다. 보안/사용자 승인 보호를 편의상 약화하지 않는다.

## 작업 시작

현재 저장소를 먼저 조사한다. 기존 앱, 설정, 사용자 파일, Git 변경 상태를 확인하고 자동 reset/clean/stash하지 않는다. 명세 패키지가 저장소 안에 있으면 `spec/` 같은 별도 폴더에 보존한다. 코드 scaffold가 필요한 빈 저장소라면 monorepo를 구성한다. 사용자에게 이미 명시된 플랫폼·사용 도구를 다시 묻지 않는다.

실제 환경에서 Electron, Node, pnpm, TypeScript, React, MCP SDK, Playwright, SQLite 드라이버의 설치 가능한 안정 버전과 라이선스를 확인하고 정확한 lockfile을 만든다. 공식 MCP SDK의 현재 세대와 사용하는 client 규격을 확인한다. 인터넷 예제의 구버전 import를 최신 버전에 섞지 않는다. docs/compatibility.md에 runtime/CLI/SDK/protocol/browser/OS 조합을 기록한다.

존재하지 않는 boxspec npm 패키지를 설치하지 않는다. 본 문서의 boxspec 이름은 지금 구현할 제품이다. 기존 agent의 로그인 토큰/API 키를 검색·추출하거나 다른 서비스로 재전송하지 않는다.

## 반드시 먼저 완성할 수직 경로

1. Electron 앱에서 프로젝트와 화면 생성.
2. 헤더 64, sidebar 260, main fill 구조 작성·저장·재실행.
3. hard/soft/free 정책과 revision.
4. 결정적 React layout shell 생성.
5. 로컬 stdio MCP bridge를 실행하고 실제 외부 client에서 context 읽기.
6. 승인 프로젝트의 별도 worktree에 slot 구현.
7. frozen candidate를 실제 browser에서 render.
8. geometry·build·검색 상호작용 검증.
9. 실제 변화와 위반을 UI에 표시.
10. 사용자 승인 후 검증된 hash와 동일한 파일만 원본 반영.
11. sidebar 320px 위반을 자동 차단.
12. apply 중 crash와 사용자 source drift 복구.

이 경로가 동작하기 전에 스타일 후보 생성·자유 손그림 인식·Unity·React Native·팀 협업을 먼저 구현하지 않는다. 반대로 첫 수직 데모로 전체 P1 완료를 선언하지 말고 B00–B16의 보안·복구·설치·호환 작업까지 진행한다.

## 모듈과 서브에이전트

가능한 환경이면 실제 subagent를 활용한다. 기본 동시 구현 worker는 3개 이내다. 같은 파일의 동시 writer는 1개다. 총괄만 공용 인터페이스와 통합 결정을 변경한다.

- Contract/Core worker: schemas, semantic validation, commands, revisions, persistence.
- Editor worker: canvas, inspector, keyboard/IME, spatial diff, review UX.
- Integration worker: project grants, MCP bridge, execution profiles, change manager.
- 단계 후반 Verifier worker: 실제 render, geometry assertions, regression, evidence.
- 독립 Reviewer: hard 우회, 원본 보호, 경로/권한, 거짓 PASS, stale candidate 공격을 검사.

동시 인원이 제한되면 같은 역할을 순차 수행한다. 실제로 쓰지 않은 모델이나 agent를 사용했다고 보고하지 않는다. 특정 provider/model 이름을 추측하지 말고 환경에서 확인된 것만 사용한다.

worker에게는 작업 ID, 소유 경로, 읽을 계약 버전, 의존 인터페이스, 금지 범위, 완료 명령·증거를 주어라. 검증 실패를 숨기는 worker 보고는 완료로 받지 않는다.

## 구현 제한

- `run_shell`, `approve`, `unlock`, `apply_to_main`, `read_secret` 같은 권한 우회 MCP 도구를 만들지 않는다.
- 에이전트가 제출한 pass/fail이나 screenshot 경로를 그대로 신뢰하지 않는다.
- trusted verifier와 policy를 agent 수정 폴더 안에서 불러오지 않는다.
- worktree/process 분리를 filesystem/network sandbox라고 부르지 않는다.
- 외부 agent에 원본 접근 권한이 있으면 앱 밖의 수정까지 막을 수 없음을 UX에 반영한다.
- preview HTML을 trusted editor DOM에 삽입하지 않는다. editor Node integration을 켜지 않는다.
- 이름만 연결된 mock adapter, fake screenshot, hardcoded successful tool result로 완료하지 않는다.
- 기존 프로젝트 전체를 재생성하지 않는다. UI scope 밖의 비즈니스 로직을 보호한다.
- App Server 등 공식 문서에서 실험적이라고 밝힌 경로를 P1 필수 의존성으로 만들지 않는다.
- 모든 상태에서 unknown/unsupported/not-run은 PASS가 아니다.

## 테스트·진행 보고

각 작업마다 실제 실행 명령, exit code, 테스트 요약, 생성 산출물, 미해결 사항을 docs/progress.md에 기록한다. 타입 검사·unit·contract·integration·browser E2E를 분리한다. 마지막에 보안 negative tests를 독립 실행한다.

실제 agent client가 설치/인증되지 않았다면 환경 제한을 정확히 기록하고 해당 호환 항목을 미검증으로 남긴다. 다른 구현 가능한 경로를 계속 진행하며 단순 계획 문서로 끝내지 않는다. 권한이나 유료 서비스 인증을 필요 이상으로 자동 우회하지 않는다.

UI는 짙은 작업 공간, 제한된 border, 읽기 쉬운 13px 텍스트, 좌측 232/우측 304px 기본 패널을 따른다. 쓸모없는 카드·hero section·그라디언트·장식 아이콘을 만들지 않는다. 명세의 다크/라이트 토큰을 사용하되 대비 테스트로 보정한다.

## 최종 전달물

실행 가능한 앱 소스, 재현 가능한 lockfile/build scripts, Windows 설치 산출물(가능 환경에서 실제 생성), 개발용 stdio MCP 실행 entry, 3-client 설정 마법사, 샘플 React 프로젝트, 실제 검증 report, 보안·복구 테스트, 사용 가이드와 진단 명령을 제공한다.

완료 보고는 실제 구현/실제 테스트/미검증/출시 차단 항목을 분리한다. 구현되지 않은 기능을 미래형 설명으로 감추지 않는다. P2/P3는 명세가 있다는 이유만으로 지원 완료에 포함하지 않는다.

지금 저장소 조사와 B00–B02부터 시작하고, 첫 수직 경로를 만든 후 P1 완료 조건까지 단계적으로 구현하라.
