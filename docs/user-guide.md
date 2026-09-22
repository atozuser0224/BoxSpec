# BoxSpec P1 사용자 가이드

> 현재 상태: 개발 소스 기준 안내서다. Windows 설치본, 서명·업데이트, 세 MCP 클라이언트의 실제 종단 간 호환성은 아직 출시 검증을 통과하지 않았다. 기능이 화면에 없거나 `CAPABILITY_UNAVAILABLE`을 반환하면 구현되지 않은 기능으로 취급한다.

> 2026-09-22 통합 상태: 최종 `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test`가 모두 종료 코드 0으로 통과했다. Adopted Web 패키지는 컴파일만 확인했으며 제품 통합·테스트가 완료되지 않았다. 프리릴리즈와 전체 P1 출시 기준 통과는 구분한다. 설치본의 최신 확인 결과는 [릴리즈](https://github.com/atozuser0224/BoxSpec/releases)와 [패키징 증거](evidence/packaging.md)를 참고한다.

BoxSpec은 승인한 React/TypeScript/Vite 프로젝트의 레이아웃 계약을 편집하고, 외부 코딩 에이전트가 만든 후보를 별도 작업 공간에서 검증한 뒤 사용자가 원본 반영을 결정하는 Windows 데스크톱 도구다. P1에서 검증 대상으로 삼는 target은 `web-react`뿐이다. Unity uGUI와 React Native Android 값은 향후 호환용 데이터 형태이며 현재 지원 기능이 아니다.

| 영역 | 이 소스 트리의 상태 |
|---|---|
| 데스크톱 editor | 실제 Electron 7/7에서 live draft/group/theme apply/relaunch 통과 |
| MCP | SDK runtime context test와 실제 Codex capabilities/context read 통과; OpenCode 미검증, Claude Code 없음 |
| verifier | standalone Chromium PASS/FAIL 검증 완료; packaged default profile bundle/Electron smoke 전이라 설치본 verifier는 현재 unavailable |
| apply/recovery | native helper와 change-manager 실제 apply/restart-recovery 통과; packaged helper copy/hash/signature 검증 전이라 출시본 운영 불가 |
| doctor/client 설정 | doctor는 `DEGRADED`/exit 2; 별도 Codex 호환 smoke는 통과, OpenCode/Claude는 미검증 |
| agent layout 제안 | 실제 SDK→MCP→Electron auto canvas→pointer edit→publish→context/relaunch E2E 통과 |
| 디자인 테마 | local 17-preset catalog 검증, Atlassian preset apply/context/save/relaunch E2E 통과; 17개 전체의 시각 비교는 미실행 |
| source drift | managed export/generated restore·contract draft import·generated unmanage runtime test 통과; Electron/설치본 drift E2E는 미실행 |
| 설치·업데이트 | Windows package/sign/update/uninstall은 출시 검증 전 |

## 개발 소스 실행

요구 환경은 Windows, Node.js 24 이상과 pnpm 11.19.0이다. 이 저장소에서 확인한 개발 버전은 Node 24.19.0과 pnpm 11.19.0이다.

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm dev
```

빌드된 데스크톱 앱은 다음 명령으로 연다.

```powershell
pnpm --filter @boxspec/desktop start
```

BoxSpec 소스 저장소 자체를 controlled apply 대상 프로젝트로 사용하지 않는다. 격리된 Git demo는 존재하지 않는 새 경로에 다음처럼 만든다. script는 기존 경로 덮어쓰기를 거부하고 demo 내부에만 Git identity를 설정한다.

```powershell
powershell -File scripts/create-demo-project.ps1 -OutputPath C:\path\to\boxspec-demo
```

출시 설치본과 번들 런타임은 아직 검증되지 않았으므로 개발 명령은 시스템 Node를 사용한다.

## 기본 작업 흐름

1. 데스크톱 앱을 열고 프로젝트 폴더를 선택한다. 폴더 선택은 프로젝트를 즉시 수정하지 않는다. 프로젝트 읽기, 후보 쓰기, 검증 권한은 구분된다.
2. 기존 화면을 선택하거나 직접 설계할 화면을 수동으로 만든다. Agent-first 흐름에서는 빈 화면을 먼저 만들지 않는다. 화면이 없는 프로젝트를 pairing하면 BoxSpec이 1440×900 `Agent Layout` r1 anchor를 내부 생성한다.
3. canvas와 inspector에서 영역을 선택하고 크기·레이아웃·정책을 편집한다. 명령은 현재 `revision`을 기준으로 처리되며 오래된 화면에서 보낸 변경은 `REVISION_CONFLICT`가 될 수 있다.
4. 편집 revision은 local store에 먼저 보존된다. Toolbar의 **LOCAL SAVED · SOURCE PENDING**은 local revision은 안전하지만 contract/generated source export가 아직 남았다는 뜻이다. `Ctrl+S` 뒤 **LOCAL SAVED · EXPORTING**을 거쳐 **SOURCE SYNCED**가 된 뒤에만 source 동기화를 완료로 본다. 오류나 drift가 나오면 synced로 간주하지 않는다.
5. Clients에서 클라이언트를 선택하고 **Pair local client for 24 hours**를 누른다. desktop은 durable grant를 만든 뒤 current-user-only named pipe host가 프로젝트 ID 이름의 보호 profile을 쓰게 한다. 실패하면 grant를 폐기한다. 기본 권한은 `read`, `candidate-write`, `verify`로 구분되며 grant는 client 자기 선언이 아니라 BoxSpec 승인 기록이다.
6. 클라이언트별 설정을 생성·검토한다. `구성됨(configured)`은 파일이 작성됐다는 뜻이며 `연결됨(connected)`이 아니다. 실제 클라이언트가 `boxspec_get_capabilities`와 해당 프로젝트의 `boxspec_get_context`를 성공해야 연결 완료로 본다.
7. 외부 에이전트에는 `agent/USE_BOXSPEC_PROMPT.md` 형식의 handoff를 제공한다. 에이전트는 먼저 capabilities를 읽고, 지정 revision과 node scope로 context를 읽은 뒤 승인된 staging 작업 공간만 수정해야 한다.
8. 후보 제출과 검증이 끝나면 report 상태와 모든 필수 check를 확인한다. `PASS`만 검토 요청이 가능하다. `FAIL`, `UNVERIFIED`, `ERROR`, `STALE`, `NOT_RUN`, `UNSUPPORTED`를 성공으로 해석하지 않는다.
9. trusted UI에서 diff, 공간 변화, 위반, candidate/report/hash/revision을 확인한다. 승인과 원본 적용은 MCP 도구가 아니라 이 UI에서만 수행한다. 현재 개발 소스의 change-manager/native-helper 통합 시험은 통과했지만 package 검증 전이므로 출시 운영에 사용하지 않는다.
10. 적용 직전 source drift 검사가 다시 실행된다. 원본이 달라졌으면 적용을 멈추고 재기준 설정과 새 검증을 거친다.

현재 editor 단축키는 `Ctrl+S` 저장, `Ctrl+Z` undo, `Ctrl+Shift+Z` 또는 `Ctrl+Y` redo, `Ctrl+G` group, `Ctrl+Shift+G` ungroup, `V` 선택, `R` 영역 만들기, 화살표 1px 이동, `Shift+화살표` 8px 이동이다. Align/distribute는 같은 parent의 top-left anchor·fixed width/height box에만 사용할 수 있으며 조건이 안 맞으면 UI에 비활성 이유가 표시된다. 하나의 box를 키보드만으로 옮길 때는 **New parent**에서 leaf·현재 parent·자기 자신·descendant가 아닌 container를 골라 **Move**를 누른다. 한글 IME 조합 중에는 canvas 단축키를 실행하지 않도록 되어 있지만 실제 native IME/DPI E2E는 아직 출시 검증 전이다.

## 디자인 테마 선택

1. 편집할 화면이나 AI live draft를 연 뒤 toolbar의 **디자인 테마**를 누른다.
2. **Search themes**, **Mode**(`Light`/`Dark`/`Mixed`), **Style** 필터로 17개 local preset을 좁힌다.
3. 카드에서 이름·설명·태그를 보고, 오른쪽의 palette·type·radius와 generated token study를 비교한다. **Source** 링크는 영감 출처와 provenance를 확인하는 용도다.
4. 원하는 preset을 선택하고 **이 테마 적용**을 누른다. 선택만 해서는 화면이 바뀌지 않는다.
5. 승인 화면에 적용하면 새 contract revision이 생긴다. AI live draft에 적용하면 approved revision은 그대로이고 `draftRevision`만 증가한다. Draft는 나중에 **이 배치로 구현**을 눌러야 승인 계약에 publish된다.
6. Canvas 색과 typography를 확인한다. Approved screen이면 `Ctrl+S`로 source export하고, live draft이면 **이 배치로 구현**으로 publish한다. 필요하면 앱을 다시 열어 유지 여부를 확인한다.

테마 적용은 `designSystem`의 presentation token을 교체한다. Node ID, 순서, parent, layout, placement, lock과 geometry는 유지한다. 따라서 테마는 구조 재배치나 기존 앱의 component library import 기능이 아니다. Agent가 다음 구현을 시작할 때는 적용 후 revision의 `boxspec_get_context`를 다시 읽어 새 design-system ID와 token을 사용한다.

Managed React generator `boxspec-react-shell/1.1.0`은 이 token을 generated CSS의 root background/text/accent/body font, surface/radius, button accent/radius와 inherited color·font·radius·border·spacing 변수로 내보낸다. Contract에 명시된 padding, gap, size, placement는 theme spacing으로 덮어쓰지 않는다. Generator 1.0→1.1 manifest 변경은 예상된 generated-output 변경이지만, 사용자가 managed generated file을 직접 고친 경우에는 계속 source drift로 표시된다.

Catalog의 17개 항목은 public design-system reference와 showcase metadata를 바탕으로 BoxSpec이 작성한 작은 token 해석이다. Local SVG preview도 BoxSpec이 생성한 study이며 원본 screenshot이 아니다. Source site의 HTML·CSS·script·font·brand asset은 package에 포함하지 않는다. Material, Carbon, Fluent, Primer 같은 이름은 reference를 식별할 뿐 해당 시스템의 정확한 복제, 라이선스 부여 또는 원저작자의 보증을 뜻하지 않는다. 배포할 제품은 연결된 원본의 최신 brand·font·component license를 별도로 검토한다. Source와 catalog 수집 경계는 [theme source evidence](evidence/theme-sources.md)에 있다.

실제 Electron E2E는 17개 catalog를 열고 검색·mode·style filter를 거쳐 `Atlassian Teamwork`을 명시적으로 적용했다. Revision 34→35, token과 canvas computed color 변경, 구조 identity 유지, MCP context의 `theme_atlassian-teamwork` revision 2/11 tokens, native save와 재시작 persistence가 통과했다. 이 증거는 한 preset의 종단 간 동작을 확인한 것이며 17개 전부의 시각 품질을 비교한 결과는 아니다.

## 기본 agent ↔ 사용자 반복 편집

기본 흐름에서는 agent가 자기 판단으로 만든 완성형 named-box UI를 BoxSpec canvas에 먼저 직접 띄운다. 사용자는 그 화면을 보고 배치를 뜯어고친 뒤에만 코드 구현을 시작시킨다.

1. Agent는 `boxspec_get_capabilities`와 현재 exact revision의 `boxspec_get_context`를 읽는다.
2. Agent는 전체 Layout Contract JSON을 `boxspec_propose_contract_change`의 `proposedContractJson`으로 보낸다. 각 UI 조각은 사람이 알아볼 수 있는 `name`과 작업을 반복해도 유지되는 node `id`를 가져야 한다.
3. Runtime은 `projectId`, `screenId`, `expectedRevision`, base hash와 계약 schema를 검사하고 proposal을 `AWAITING_USER`로 내부 저장한다. BoxSpec은 완성형 box layout을 별도 import/승인 단계 없이 승인 계약과 분리된 live draft canvas에 표시한다. 이 동안 승인된 revision은 변하지 않는다. 사용자가 편집 중인 dirty draft가 있으면 새 AI draft가 그것을 덮어쓰지 않고 배너로 알린다. 현재 별도 proposal inbox는 제공하지 않는다.
4. 사용자는 바로 보이는 draft의 box를 이동·크기 조절·group/ungroup·align/distribute·reparent하고 이름을 다듬는다. 기존 box와 ungroup된 child는 ID를 유지한다. 복제한 box, 새 group과 새 box에만 새 ID를 부여한다.
5. 사용자가 **이 배치로 구현**을 누르면 그 배치를 trusted user action으로 새 승인 계약 revision에 publish하고 구현 handoff를 만든다. 이 동작은 layout 의도 승인이다. 코드 candidate 승인이나 원본 적용이 아니다.
6. Agent는 handoff의 새 revision과 영향받은 node ID로 `boxspec_get_context`를 다시 읽는다. 이어 `boxspec_start_task`로 staging 작업을 시작해 구현하고 candidate를 제출·검증한다.
7. PASS인 candidate/report만 `boxspec_request_review`로 보낸다. 사용자는 별도의 Review에서 코드 diff와 증거를 확인한 뒤 코드 적용을 승인한다.
8. 사용자가 배치를 다시 고치면 새 revision에서 1–7을 반복한다. 이전 context, candidate, PASS 또는 승인을 재사용하지 않는다.

첫 화면도 사용자가 빈 화면을 미리 만들게 하지 않는다. Pairing할 때 화면이 하나도 없으면 BoxSpec이 `Agent Layout` r1 anchor와 root selection을 내부 생성한다. Agent는 `boxspec_get_context`로 얻은 그 exact revision을 base로 첫 draft를 제안한다.

Desktop source는 저장된 `AWAITING_USER`/`USER_EDITING_DRAFT` draft를 5초마다 poll하고, 최신 draft를 active/dirty canvas가 없을 때 자동으로 연다. 사용자가 이미 편집 중이면 기존 canvas를 유지하고 **New AI layout draft available** 배너만 표시한다. Draft 편집은 `draftRevision`만 올리고 approved revision은 그대로 유지한다. **이 배치로 구현**은 base revision/hash와 draft revision을 다시 검사한 뒤 정확히 한 번 publish한다. Handoff에는 old/new revision·hash와 added/changed/removed/affected node ID가 들어가며, 화면은 **Layout sent for implementation**, 새 revision, 영향 node 수, `AWAITING_AGENT`, handoff ID를 표시한다. 이 경로는 `approveAndApply`를 호출하지 않는다.

Runtime은 draft 격리, edit 시 `USER_EDITING_DRAFT`, base 변경 시 `STALE`, publish 시 node ID diff와 competing draft stale 처리를 구현했고 통합 테스트에서 isolate/update/publish/reopen을 확인했다. Desktop과 canvas에는 move/resize/create/delete/duplicate/group/reparent가 연결돼 있다. 실제 Electron 7/7에서는 별도 SDK 프로세스의 r33 proposal, 자동 canvas 표시, pointer resize 72→91, Ctrl 다중 선택과 Ctrl+G, stable group ID와 외부 context의 parent 확인, **이 배치로 구현**, `AWAITING_AGENT` r34, 외부 `boxspec_get_context` r34/hash, theme 적용 r35와 앱 재시작 후 유지까지 통과했다. 상세 증거는 [E2E evidence](evidence/e2e.md)에 있다. Native save는 성공했지만 관측값이 약 11초였으므로 500ms 성능 목표 통과를 주장하지 않는다.

Ungroup, align/distribute와 keyboard-only reparent는 source-built됐지만 Electron 7/7에서는 아직 직접 실행하지 않았다. 남은 기능 한계는 stale draft rebase, handoff 재열기와 전용 copy 버튼이다.

BoxSpec은 screenshot 한 장이나 기존 source에서 모든 box와 stable ID를 자동 추출하지 않는다. Agent가 명시적인 계약 초안을 보내거나 사용자가 canvas에서 구조를 만든다. 또한 **이 배치로 구현**은 외부 Codex/Claude Code/OpenCode 대화를 자동으로 깨우는 버튼이 아니다. 구현된 client별 session transport가 없으므로 화면의 handoff ID와 새 revision을 해당 외부 agent에 전달하고 다시 실행해야 한다. 설계 기준과 현재 비목표는 [ADR 0007](adr/0007-agent-user-layout-handoff.md)에 기록돼 있다.

외부 에이전트가 BoxSpec의 staging 경로뿐 아니라 원본 저장소에도 별도 파일 접근 권한을 갖고 있다면, BoxSpec은 앱 밖에서 발생한 원본 수정을 막을 수 없다. 원본 접근 권한은 제거하거나 읽기 전용으로 제한하고, 원본 변경은 항상 drift로 취급한다. worktree와 별도 프로세스는 파일시스템 또는 네트워크 sandbox가 아니다.

## 외부 에이전트가 지켜야 할 순서

```text
boxspec_get_capabilities
→ boxspec_get_context(expectedRevision 포함)
→ boxspec_start_task 또는 boxspec_get_task
→ staging에서만 구현
→ boxspec_submit_candidate
→ boxspec_verify_candidate
→ boxspec_get_report
→ PASS인 동일 candidate/report만 boxspec_request_review
→ trusted UI에서 사람이 승인·적용
```

쓰기 성격의 MCP 요청에는 새 `requestId`가 필요하다. 동일 principal에서 동일 `requestId`와 동일 payload를 재전송하면 기존 결과를 재사용하고, 같은 ID에 다른 payload를 보내면 오류다. 에이전트는 `approve`, `unlock`, `apply_to_main`, `run_shell`, `delete_project`, `read_secret`를 호출할 수 없다. 그런 도구는 제공되지 않는다.

## 상태 읽기

| 상태 | 의미 | 사용자 조치 |
|---|---|---|
| `PASS` | 같은 frozen candidate와 검증 입력에 대해 필수 check가 모두 통과 | trusted UI에서 증거와 diff 검토 |
| `FAIL` | 측정된 위반이나 결정적 실패 | 새 후보로 수정 후 다시 검증 |
| `UNVERIFIED` | 필수 환경·브라우저·check가 없거나 실행되지 않음 | 누락된 환경을 복구하고 다시 검증 |
| `ERROR` | verifier 또는 실행 환경 오류 | 로그와 실행 프로필을 고친 뒤 다시 검증 |
| `STALE` | 후보, 계약, 정책, profile, fixture, baseline 또는 원본 기준이 변함 | 새 기준에서 후보를 만들고 다시 검증 |

sidebar를 320px로 바꾸는 후보처럼 hard 계약을 어기는 변경은 원본에 적용되면 안 된다. 에이전트의 “완료” 메시지나 AI 리뷰는 PASS를 대신하지 않는다.

## 문제가 생겼을 때

- 설치·업데이트·제거 상태는 [설치/업데이트 런북](runbooks/install-update.md)을 따른다.
- MCP 설정 후 도구가 보이지 않으면 [MCP 연결 런북](runbooks/mcp-connection.md)을 따른다.
- 빌드·geometry·상호작용 검증이 불안정하면 [검증 런북](runbooks/verification.md)을 따른다.
- 적용 도중 앱이나 프로세스가 종료됐으면 [적용 복구 런북](runbooks/apply-recovery.md)을 따른다.
- 원본 파일이 바뀌었다는 경고가 나오면 [source drift 런북](runbooks/source-drift.md)을 따른다.
- 에이전트 반복 제한이나 사용량 한도에 도달했으면 [agent budget 런북](runbooks/agent-budget.md)을 따른다.

요구사항 기준은 [P1 acceptance map](p1-acceptance.md), 현재 증거 판정은 [release checklist](release-checklist.md), 실제 조합과 미검증 항목은 [compatibility matrix](compatibility.md)를 참고한다. `spec/` 아래 원본 명세와 예제는 보존 자료다. 사용자 프로젝트 작업이나 문제 해결 과정에서 수정하지 않는다.
