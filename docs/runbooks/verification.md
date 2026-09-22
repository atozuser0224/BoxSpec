# 후보 검증 런북

## 시작 전 확인

- 후보는 live worktree가 아니라 frozen snapshot이어야 한다.
- candidate의 tree hash와 contract/effective contract/override hash, base revision/commit/manifest, generator, policy, dependency lock, fixtures, verification profile identity가 고정돼야 한다.
- verifier는 trusted contract, policy, fixture, baseline을 candidate 폴더에서 읽지 않는다.
- 실행 profile은 절대 executable, argv 배열, candidate 내부 cwd, timeout을 사용한다. shell 문자열이나 임의 MCP 명령을 실행하지 않는다.

개발 검증 명령:

```powershell
pnpm --filter @boxspec/verifier test
```

현재 기록된 실제 browser/security 통합 실행은 다음 명령이다.

```powershell
node packages/verifier/node_modules/vitest/vitest.mjs run packages/verifier/tests/security.test.ts packages/verifier/tests/verifier.integration.test.ts --reporter=verbose --maxWorkers=1
```

이 실행은 exit 0, 2 files/10 tests였다. Chromium 153.0.8010.12에서 정상 dashboard는 header 64/sidebar 260/main left 260과 search interaction을 PASS했고 25개 render/screenshot을 남겼다. sidebar 320 후보는 FAIL/15 violations, overlay 후보는 interaction FAIL이었다. 증거와 report ID/digest는 [verifier evidence](../evidence/verifier.md)에 있다.

전체 저장소 검사는 다음과 같다.

```powershell
pnpm typecheck
pnpm test
```

이 명령이 성공해도 특정 사용자 candidate가 PASS라는 뜻은 아니다. 사용자 candidate는 runtime이 `verifyCandidate(input)`에 전달한 동일 snapshot과 승인 profile로 검증해야 한다.

## 설치본 기본 profile 상태

Verifier-owned production/dev profile factory, wrapper, 5개 fixture와 strict manifest/closure validation은 source test를 통과했다. 실제 browser integration은 5/5, manifest/security는 11/11 PASS다. 그러나 package의 `resources/verification-tools.json`, pinned tool/browser/fixture asset staging과 Electron-owned installed smoke는 아직 pending이다. 따라서 현재 설치본의 default verifier profile은 **UNAVAILABLE**로 취급한다.

완성된 경로에서는 Desktop이 trusted resources manifest에서 default profile ID, execution profile ID, typecheck/build entry, Chromium executable과 5개 fixture의 path·size·SHA-256을 읽는다. Absolute/canonical containment, regular-file/reparse 상태와 closure를 검사한 뒤에만 runtime에 profile을 등록해야 한다. Manifest, browser, tool 또는 closure가 없거나 다르면 verifier capability는 false여야 하며 system browser, `PATH`, project file 또는 부분 profile로 fallback하지 않는다.

## report 판정

| report 상태 | 판정 규칙 |
|---|---|
| `PASS` | 모든 required check가 실제로 PASS이고 snapshot identity가 시작·종료 시 동일 |
| `FAIL` | 정책·빌드·geometry·상호작용 등에서 측정된 blocking 위반 존재 |
| `UNVERIFIED` | required check가 미실행, unavailable 또는 unsupported |
| `ERROR` | verifier/브라우저/프로세스 환경 예외로 완료하지 못함 |
| `STALE` | 검증 중 또는 이후 candidate나 입력 identity가 달라짐 |

check의 `NOT_RUN`과 `UNSUPPORTED`는 report PASS에 포함될 수 없다. agent 메시지, 임의 screenshot, candidate가 작성한 report 파일도 신뢰 증거가 아니다.

## 일반 실행 절차

AI layout draft에서 시작했다면 사용자의 **이 배치로 구현**은 계약 revision publish와 구현 handoff까지만 수행한다. Agent는 handoff의 `newRevision`과 `affectedNodeIds`를 사용해 `boxspec_get_context`로 exact context를 다시 읽고 `boxspec_start_task`로 별도 코드 작업을 시작해야 한다. Layout publish를 code candidate 승인으로 재사용하지 않는다.

승인 화면에 디자인 테마를 적용하면 contract revision과 design-system identity가 바뀐다. 이전 task/candidate/report는 재사용하지 않고 새 revision의 context에서 다시 구현·검증한다. Live draft에 적용한 테마는 draft에만 머물며 **이 배치로 구현**으로 publish된 뒤 같은 규칙을 따른다. Theme preview나 canvas 색 변경만으로 candidate `PASS`를 주장하지 않는다.

1. 구현이 끝나면 `boxspec_submit_candidate`로 후보를 고정하고 반환된 candidate ID와 hash를 기록한다.
2. `boxspec_verify_candidate`에 해당 task/candidate와 승인된 verification profile을 전달한다. 새 요청에는 고유 `requestId`를 쓴다.
3. 작업이 끝나면 `boxspec_get_report`로 server report를 읽는다.
4. check별 상태, blocking violation, viewport, fixture, node ID와 artifact ID를 확인한다.
5. 증거는 호출자가 승인한 절대 evidence root 아래 새 `<reportId>/` 디렉터리에 생성된다. 구현된 레이아웃은 `build/`, `artifacts/`, `typecheck.log`, `build.log`, `report.json`이며 screenshot·metrics·interaction 증거는 artifact ID로 찾는다. candidate가 제시한 임의 경로를 열지 않는다.
6. 실패를 수정할 때 frozen candidate를 덮어쓰지 않는다. staging을 수정해 새 candidate를 제출하고 다시 검증한다.
7. 동일 실패 자동 수정은 기본 최대 2회다. 그 뒤에는 [agent budget 런북](agent-budget.md)에 따라 중단한다.
8. `PASS`인 동일 candidate/report만 `boxspec_request_review`로 보낸다. 이 호출은 승인이나 적용을 수행하지 않는다.

## flaky 또는 환경 실패

1. report ID와 check ID를 유지한 채 fixture, profile, Playwright browser, font, locale/timezone, viewport/DPR, animation 상태를 비교한다.
2. Playwright 1.63.0에 맞는 managed Chromium 또는 hash 승인된 명시적 browser executable인지 확인한다. 다른 cache가 존재한다는 사실만으로 준비됐다고 판단하지 않는다.
3. 브라우저 request interception은 preview context에만 적용되며 전체 프로세스의 네트워크 sandbox가 아니다.
4. timeout은 PASS가 아니다. 실행 profile의 승인된 제한 안에서 원인을 고치고 새 검증을 시작한다.
5. baseline을 자동 갱신하지 않는다. 의도된 변경이라면 사람이 diff를 검토하고 baseline/revision 변경을 승인한 뒤 새 candidate를 검증한다.

## 주요 실패 조치

| 오류 | 조치 |
|---|---|
| `CANDIDATE_STALE` / `STALE` | 현재 계약·정책·profile·fixture·원본 기준에서 새 candidate 생성 |
| `VERIFY_FAILED` / `FAIL` | violation의 viewport/fixture/node를 수정한 새 candidate 제출 |
| `UNVERIFIED` | 누락된 browser/check/profile을 준비; 성공으로 우회하지 않음 |
| `ERROR` | command stderr, timeout, executable 절대 경로, cwd와 browser launch 확인 |
| 320px sidebar 위반 | sidebar를 계약의 260px hard 값으로 복구하고 새 candidate 검증 |

현재 verifier는 accessibility audit와 screenshot-baseline comparison을 지원하지 않는다. 계약에서 이를 required check로 요구하면 `UNSUPPORTED`이며 PASS를 막는다. 실제 browser 증거가 있어도 승인/apply, 세 실제 client와 설치본 E2E를 입증하지는 않는다. 현재 판정은 [release checklist](../release-checklist.md), 미검증 환경은 [compatibility matrix](../compatibility.md), 요구사항은 [P1 acceptance map](../p1-acceptance.md)에서 확인한다.
