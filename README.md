# BoxSpec

BoxSpec is now an implementation workspace for the Windows local-first layout contract editor described by the preserved production package in [`spec/`](spec/). The original package README remains at [`spec/README.md`](spec/README.md); current implementation evidence is in [`docs/progress.md`](docs/progress.md) and the supported developer workflow is in [`docs/user-guide.md`](docs/user-guide.md).

## Windows preview

[Download the Windows x64 prerelease](https://github.com/atozuser0224/BoxSpec/releases). Choose the setup executable, or extract the portable ZIP and run `BoxSpec.exe`. These preview artifacts are unsigned; production signing, automatic updates, and the complete P1 release campaign are not finished.

AI가 먼저 UI를 박스로 구성하고, 사용자가 배치와 크기를 고친 뒤 **이 배치로 구현**을 눌러 코딩 에이전트에게 전달합니다. 디자인 테마창에서는 출처가 표시된 17개 프리셋을 골라 캔버스와 생성되는 UI에 적용할 수 있습니다. 미리보기는 참고 디자인을 바탕으로 만든 BoxSpec 샘플이며 원본 사이트의 복제본이 아닙니다.

The release includes the Electron runtime, local MCP bridge, native filesystem helper, and trusted browser/toolchain. Code changes require verification and a separate user approval before applying to the project. See the [user guide](docs/user-guide.md) and [release checklist](docs/release-checklist.md) for tested scope and remaining limitations.

## Run the development build

Requirements: Windows, Node.js 24 or newer, and pnpm 11.19.0.

The canonical native helper is a release asset, not a Git-tracked executable. For development, place the release's `boxspec-safe-fs.exe` at `crates/boxspec-safe-fs/bin/boxspec-safe-fs.exe`; its pinned SHA-256 is `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`. Source writes and apply fail closed when it is missing or mismatched. Native source and build instructions are in [crates/boxspec-safe-fs](crates/boxspec-safe-fs/README.md).

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm dev
```

Run the built app with `pnpm --filter @boxspec/desktop start`. Run redacted diagnostics with `pnpm run doctor`; a degraded environment intentionally exits with code 2. The sample React/Vite project is [`samples/react-dashboard`](samples/react-dashboard). Create an isolated Git demo without overwriting an existing path using `powershell -File scripts/create-demo-project.ps1 -OutputPath C:\path\to\boxspec-demo`. The script sets identity only in that new repository. Do not use this implementation repository as the controlled-apply target.

Windows packaging is run directly with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/build-windows.ps1`. The script builds its production dependency graph in an isolated `build/package-workspace`; never run `pnpm deploy` from the source workspace. Artifacts remain unsigned unless a real signing identity is configured. P1 is not release-ready until the blockers in [`docs/release-checklist.md`](docs/release-checklist.md) are closed.

## Agent-first layout loop

The default product flow starts with the coding agent drawing a complete named-box layout through `boxspec_propose_contract_change`. BoxSpec opens that isolated draft directly on the canvas. The user edits it and chooses **이 배치로 구현**; BoxSpec publishes a new layout revision and returns the stable-ID implementation handoff that the agent reads with `boxspec_get_context`. This layout publication is separate from the later verified code review and apply decision. See [`docs/adr/0007-agent-user-layout-handoff.md`](docs/adr/0007-agent-user-layout-handoff.md).

---

# Preserved package overview

**사각형으로 UI 구조를 정하고, AI 코딩 에이전트가 그 구조를 유지하며 구현하게 만드는 Windows 데스크톱 프로그램의 설계 패키지**다.

이 패키지는 기획서·스키마·개발 지시문이다. 실행 가능한 BoxSpec 앱이나 이미 연결된 MCP 서버가 아니다. 예제 실행 경로는 제품을 구현한 뒤 실제 경로로 교체해야 한다.

## 가장 먼저 읽을 파일

| 파일 | 용도 |
|---|---|
| `BoxSpec_Production_Plan_ko.md` | 31개 주절(0–30), 제품·UX·기술·보안·검증·MCP·출시 기준 |
| `agent/BUILD_AGENT_PROMPT.md` | 코딩 에이전트에게 BoxSpec 자체 구현을 맡기는 시작 지시문 |
| `agent/AGENTS.md` | 저장소에 병합할 지속 개발 규칙 |
| `agent/USE_BOXSPEC_PROMPT.md` | 완성된 제품으로 사용자의 UI 프로젝트를 수정하는 agent 지시문 |
| `contracts/layout-contract.schema.json` | Layout Contract 핵심 데이터 schema |
| `contracts/context-slice.schema.json` | 대규모 계약을 읽기 전용으로 나눠 전달하는 문맥 조각 schema |
| `contracts/mcp-tools.json` | 구현해야 할 15개 MCP 도구의 입력·출력 schema |
| `examples/dashboard.contract.json` | 고정 헤더·사이드바·본문의 desktop/compact 계약 예제 |
| `examples/*mcp*`, `examples/opencode.example.json`, `examples/codex.example.toml` | agent별 설정 형식. 비밀정보 없음 |
| `tools/validate_spec.py` | 계약·도구 schema와 수동 작성 geometry fixture 정적 검사 |
| `SPEC_VALIDATION_REPORT.json` | 실제 실행한 정적 명세 검사 결과. 제품 실행 검증 아님 |

## 에이전트에 넘기는 방법

이 폴더를 개발 작업 공간에 넣고 `agent/BUILD_AGENT_PROMPT.md` 내용을 시작 지시로 전달한다. 기존 저장소라면 내용을 덮어쓰지 말고 먼저 조사하도록 한다. 문서의 B00–B16을 첫 출시 범위로 사용한다. Unity/RN는 해당 단계의 별도 출시 gate를 통과해야 지원으로 표시한다.

코드를 작성하는 worker, 구조를 생성하는 compiler, 실제 화면을 확인하는 verifier, 최종 승인하는 사용자의 권한을 분리하는 것이 핵심이다. `AI에게 잘 지키라고 부탁`하는 것만으로 구현을 끝내지 않는다.

## 정적 명세 검사

Python 3.10 이상에서 아래를 실행한다. 이 명령은 앱을 실행하거나 프로젝트 코드를 수정하지 않는다.

```sh
python -m pip install -r tools/requirements.txt
python tools/validate_spec.py
```

`metrics.*.json`은 사람이 작성한 테스트 데이터다. 실제 browser/Unity/Android에서 관측한 결과가 아니다. 잘못된 sidebar 320px 사례를 거절하는 규칙을 설명하고 검사하는 용도다.

`tools/build_spec_assets.py`는 이 패키지의 스키마·예제 생성에 사용한 보조 스크립트다. 실행하면 해당 스키마·예제를 다시 쓰므로 수정한 명세 위에 무심코 실행하지 않는다. 전체 제품의 source generator가 아니다.

## 출처

외부 API·설정의 공식 근거와 확인일은 본 기획서 30절에 정리했다. 제품명은 가칭이며 상표·도메인 확보 여부는 검증하지 않았다. 의존성·CLI·SDK의 실제 지원 조합은 구현 단계에서 다시 확인하고 lockfile과 compatibility matrix로 고정한다.
