# MCP 연결 런북

## 성공 기준

설정 파일 생성은 연결 성공이 아니다. 다음 두 실제 호출이 같은 pairing/grant로 성공해야 `connected`로 판단한다.

1. `boxspec_get_capabilities`
2. `boxspec_get_context` — 승인된 `projectId`, `screenId`, 현재 `expectedRevision` 사용

## Agent가 live layout draft를 보내는 형식

현재 MCP 입력은 다음 형태다.

```json
{
  "requestId": "unique-request-id",
  "projectId": "project-id",
  "screenId": "screen-id",
  "expectedRevision": 1,
  "reason": "초기 화면 배치 제안",
  "proposedContractJson": "{ ...전체 Layout Contract JSON... }"
}
```

`proposedContractJson`은 일부 patch나 screenshot이 아니라 named box와 stable node ID를 포함한 전체 Layout Contract의 JSON 문자열이다. 현재 runtime은 grant, approved screen의 exact revision과 schema를 검사해 proposal을 `AWAITING_USER`로 내부 저장하며 승인 계약은 바꾸지 않는다.

입력 제한은 `expectedRevision >= 1`, `reason` 최대 8,000자, `proposedContractJson` 최대 262,144자이며 추가 필드는 거절된다. 성공 응답은 `proposalId`, `status: "AWAITING_USER"`, `baseRevision`을 반환한다.

Desktop source는 저장된 `AWAITING_USER`/`USER_EDITING_DRAFT` AI draft를 5초마다 poll하며 active/dirty canvas가 없을 때 별도 승인/import 없이 자동으로 연다. Dirty user canvas는 덮어쓰지 않고 **New AI layout draft available** 배너를 표시한다. 사용자는 draft를 편집하고 **이 배치로 구현**으로 새 approved revision과 `AWAITING_AGENT` handoff를 만든다. 이 동작은 코드 candidate 승인/apply가 아니다.

Runtime은 proposal identity, `baseRevision`/`baseContractHash`, `draftRevision`, schema와 `targetRevision = baseRevision + 1`을 검사한다. Desktop edit은 approved revision을 바꾸지 않고 draft만 `USER_EDITING_DRAFT`로 올린다. Publish는 base와 draft가 그대로일 때만 한 번 수행하며 old/new revision·hash와 added/changed/removed/affected node ID를 handoff에 기록한다. Runtime 통합 테스트는 draft isolate/update/publish/reopen을 확인했다.

실제 Electron 7/7 campaign도 별도 official SDK process→stdio bridge→인증된 pipe→r33 proposal/auto canvas→pointer resize와 Ctrl 다중 선택/Ctrl+G→stable group ID/parent 외부 reread→publish `AWAITING_AGENT` r34→외부 context r34/hash→theme 적용 r35의 design-system ID/11 tokens reread→Electron 재시작 보존을 통과했다. Layout/theme context 증거와 이 제한은 [E2E evidence](../evidence/e2e.md)에 있다.

Proposal 생성에는 push/wakeup/notification 호출이 없으므로 desktop polling이 필요하다. MCP 응답 `AWAITING_USER`만으로 draft가 canvas에 나타났거나 구현 agent가 시작됐다고 판단하지 않는다. 외부 client 자동 wakeup도 제공되지 않으므로 handoff ID와 새 revision을 해당 agent에 전달한다. Agent는 새 revision과 `affectedNodeIds`로 `boxspec_get_context`를 다시 읽고, 같은 `expectedRevision`과 필요한 `scopeNodeIds`로 `boxspec_start_task`를 호출해야 한다. 사이에 revision이 바뀌면 `REVISION_CONFLICT`이며 context부터 다시 읽는다. [ADR 0007](../adr/0007-agent-user-layout-handoff.md)이 이 경계와 비목표를 정의한다.

개발 빌드의 stdio entry는 `node apps/mcp/dist/index.js [--profile NAME]`이며 기본 profile은 `default`다. 현재 test smoke는 별도 child stdio → 인증된 named pipe → 실제 runtime context/resource read를 통과했고 15개 tool과 foreign/stale/invalid 거절을 확인했다. 명령은 다음과 같다.

```powershell
node --test apps/mcp/test/stdio-runtime.test.mjs
```

이 smoke는 exit 0, 1/1이었다. principal과 short-lived grant는 tool payload나 clientInfo가 아니라 desktop이 발급한 profile과 인증된 local IPC session에 묶인다. 현재-user profile root 기본값은 `%LOCALAPPDATA%/BoxSpec/mcp-profiles`다. `BOXSPEC_MCP_PROFILE_ROOT` override는 package/test 선택용이며 일반 연결에서 임의 profile을 만드는 수단이 아니다. 상세 증거는 [bridge evidence](../evidence/bridge.md)에 있다.

실제 Codex CLI 호환 smoke도 다음 명령으로 exit 0이었다.

```powershell
node apps/mcp/scripts/codex-cli-compat.mjs
```

확인 조합은 Codex CLI `0.155.0-alpha.9.2`, `gpt-5.6-sol`/high, read-only/ephemeral, command-line-only MCP 설정이며 `boxspec_get_capabilities`와 `boxspec_get_context`만 호출했다. global config와 token은 읽거나 쓰지 않았다. OpenCode 실제 호출은 미검증이고 Claude Code는 이 host에 없다.

아래 예제는 소스 개발용 Node entry 형식이다. 데스크톱 설정 마법사는 별도의 절대 `mcpLauncherPath`가 주입된 경우 launcher 자체를 `command`로 쓰고 `--profile <projectId>`를 붙인다. Clients의 **Pair local client for 24 hours**는 durable grant와 보호 profile을 만들며 host 시작 smoke가 통과했다. 테스트/profile smoke와 실제 Codex/Claude Code/OpenCode 연결을 혼동하지 않는다.

## 클라이언트별 설정 형식

아래 `<BOXSpec 절대 경로>`는 실제 빌드 위치로 바꾼다. Windows 경로는 `/`를 쓰면 JSON/TOML escape 실수를 줄일 수 있다. 현재 개발 경로는 시스템 Node를 사용하며, 출시본은 애플리케이션이 소유한 launcher/runtime으로 바뀌어야 한다.

Codex의 `config.toml` 항목:

```toml
[mcp_servers.boxspec]
command = "node"
args = ["<BoxSpec 절대 경로>/apps/mcp/dist/index.js", "--profile", "default"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Claude Code의 프로젝트 `.mcp.json` 항목:

```json
{
  "mcpServers": {
    "boxspec": {
      "type": "stdio",
      "command": "node",
      "args": ["<BoxSpec 절대 경로>/apps/mcp/dist/index.js", "--profile", "default"]
    }
  }
}
```

Claude CLI로 등록할 때는 client 옵션과 stdio 명령 사이의 `--` 구분을 유지한다. 정확한 CLI 옵션은 설치된 버전의 도움말로 확인한다.

OpenCode의 `opencode.json` 항목:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "boxspec": {
      "type": "local",
      "command": ["node", "<BoxSpec 절대 경로>/apps/mcp/dist/index.js", "--profile", "default"],
      "enabled": true
    }
  }
}
```

세 형식은 서로 호환되지 않는다. 기존 설정 전체를 덮어쓰지 말고 `boxspec` 항목만 병합한다. project scope 설정은 해당 저장소에서도 신뢰 결정을 요구할 수 있다.

현재 runtime의 설정 생성은 project scope만 지원한다. user scope를 선택하면 `UNSUPPORTED_CAPABILITY`이며, 사용자의 전역 설정 경로를 추측해 쓰지 않는다. 기존 Codex 설정에 `[mcp_servers.boxspec]`가 이미 있거나 기존 JSON이 올바르지 않으면 `APPLY_CONFLICT`로 멈추고 자동 교체하지 않는다. 생성된 diff를 검토한 뒤에만 적용한다.

## 진단 순서

1. BoxSpec 데스크톱 앱과 Core가 실행 중인지 확인한다. 앱이 닫혀 있으면 `APP_NOT_RUNNING` 또는 transport 종료가 정상 실패다.
2. entry가 실제로 존재하고 절대 경로가 현재 빌드를 가리키는지 확인한다. 경로의 공백·한글을 보존하고 shell 문자열로 합치지 않는다.
3. 클라이언트 프로세스에서 `node`와 entry를 실행할 수 있는지 확인한다. 개발 빌드에서는 Node 24 이상이 필요하다.
4. stdout에는 MCP protocol만 나오는지 확인한다. 진단 로그는 stderr로만 보내야 한다. stdout의 일반 로그 한 줄도 연결을 손상시킬 수 있다.
5. 데스크톱 UI에서 요청한 client/project와 `read` 권한을 확인하고 pairing을 승인한다. 프로젝트를 추측하거나 `clientInfo`만 바꿔도 권한이 생기지 않는다.
6. `boxspec_get_capabilities`를 호출한다. React 외 target이 `experimental` 또는 `unavailable`이면 그 상태를 따른다.
7. 현재 revision으로 `boxspec_get_context`를 호출한다. `REVISION_CONFLICT`이면 화면 상태를 다시 읽고 새 revision으로 처음부터 요청한다. cursor가 있으면 동일 frozen context의 cursor만 이어 쓴다.
8. 실제 두 호출 뒤에만 UI의 연결 진단을 다시 실행한다.

저장소 루트에는 doctor script가 정의되어 있다. 전체 build가 끝난 뒤 다음 명령을 사용한다.

```powershell
pnpm run doctor --json
```

`pnpm doctor`는 pnpm 자체 명령이므로 사용하지 않는다. package 직접 실행형은 `pnpm --filter @boxspec/cli run doctor`다. 지원 옵션은 `--json`, `--output <path>`, `--timeout-ms <500-60000>`, `--bridge-command <path>`, 반복 가능한 `--bridge-arg <value>`, `--state <BoxSpec 소유 doctor-state.json>`, `--help`다. 임의 state 파일을 신뢰 근거로 사용하지 않는다.

doctor는 비밀정보를 출력하지 않고 install path, bridge/core, grant 존재 여부, browser, Git, adapter와 client executable을 redacted JSON으로 구분한다. client 로그인·토큰 파일을 읽지 않는다. `clientConfiguration.<client>.data.written`과 `actualClientCall: "not-run"`은 bridge의 `handshakeSucceeded`, `toolsListed`, `capabilityCallSucceeded`와 별개다. 현재 doctor는 공식 SDK로 bridge를 호출하지만 설정된 Codex/Claude Code/OpenCode 자체를 실행하지 않으므로 각 client의 실제 호출은 계속 `not-run`이다. bridge의 capabilities 성공도 project-scoped context 성공을 대신하지 않는다.

현재 host의 실제 doctor 실행은 exit `2`/`DEGRADED`였다. built `apps/mcp` bridge와 modern MCP `2026-07-28` handshake, 15개 tool list까지 성공했지만 capabilities가 `PAIRING_REQUIRED`를 반환했다. Playwright Chromium launch, Git, Codex와 OpenCode executable probe는 PASS였고 Claude Code는 없었다. 이는 bridge transport 증거일 뿐 client별 연결·project context 증거가 아니다. 상세 redacted 결과는 [diagnostics evidence](../evidence/diagnostics.md)에 있다.

| doctor exit | 의미 |
|---:|---|
| `0` | 모든 필수 probe가 PASS |
| `1` | 하나 이상의 active FAIL |
| `2` | FAIL은 없지만 UNAVAILABLE/UNKNOWN/NOT_RUN이 남음 |
| `64` | CLI 사용법 오류 |

## 오류별 조치

| 증상/코드 | 확인 | 조치 |
|---|---|---|
| entry 없음 또는 즉시 종료 | `apps/mcp/dist/index.js`, build 결과 | `pnpm build` 후 다시 확인; 파일이 계속 없으면 bridge app 통합 미완료 |
| `APP_NOT_RUNNING` | 데스크톱/Core 상태 | 앱을 시작하고 같은 프로젝트를 다시 연다 |
| `PAIRING_REQUIRED` | pairing 요청과 client principal | Clients에서 대상 client를 선택해 24시간 pairing 승인; 수동 profile/grant 작성 금지 |
| `PROJECT_NOT_GRANTED` | grant의 projectId·만료·폐기 여부 | 올바른 프로젝트로 새 grant 발급; 다른 projectId를 재사용하지 않음 |
| `REVISION_CONFLICT` | 현재 screen revision | selection/context를 다시 읽고 새 작업 생성 |
| 도구 목록 없음 | 설정 형식, 절대 경로, stdout 오염, protocol | 클라이언트별 형식으로 수정 후 프로세스 재시작 |
| 설정됨, 연결 안 됨 | 실제 capabilities/context 호출 기록 | config 생성을 반복하지 말고 실패한 호출의 stderr·오류 코드 확인 |
| timeout/disconnect | 시작 제한, Core 응답, 두 bridge, grant | 중복 프로세스를 정리하고 bounded 요청으로 재시도; 성공으로 처리하지 않음 |

클라이언트 실제 검증 상태는 [compatibility matrix](../compatibility.md)에 기록한다. 현재 행이 `NOT RUN` 또는 `UNVERIFIED`이면 예제 설정이 존재해도 P1 호환이 입증된 것은 아니다.
