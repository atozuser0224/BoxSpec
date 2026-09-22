# Source drift 런북

Source drift는 BoxSpec이 소유권 manifest에 기록한 contract export 또는 generated output의 내용·존재·identity가 승인된 기준과 달라진 상태다. BoxSpec 밖에서 사용자가 편집했거나 원본 접근 권한을 가진 외부 에이전트가 수정한 경우도 포함한다. Candidate apply journal의 `UNKNOWN`은 별도 [적용 복구 절차](apply-recovery.md)에서 다루며 이 목록에 섞지 않는다.

## 즉시 조치

1. 현재 apply를 시작하지 않거나 중단한다. 이미 시작한 transaction이면 [적용 복구 런북](apply-recovery.md)을 먼저 따른다.
2. drift ID, 변경 경로, 감지된 tree/hash, 영향받은 task를 기록한다.
3. 관련 candidate, report, review를 `STALE`로 본다. 이전 PASS나 승인을 재사용하지 않는다.
4. 원본 파일을 자동 reset/clean/stash하거나 승인 계약을 자동 수정하지 않는다.

## 사용자가 선택할 수 있는 처리

| 선택 | 사용 시점 | 다음 단계 |
|---|---|---|
| **Propose contract update** (`propose-contract`) | 유효한 `.boxspec/screens/<screenId>.contract.json` 변경을 layout 의도로 검토하려 함 | 현재 approved rN에서 격리된 `AWAITING_USER` rN+1 draft 생성 → export는 approved bytes로 복구 → canvas 검토·편집 → **이 배치로 구현** |
| **Restore contract layout** (`restore-contract`) | 외부 변경을 폐기하고 approved contract의 결정적 출력을 복구하려 함 | native journal로 exact approved bytes 복구; generated drift이면 해당 screen output 전체 unit 복구 → 새 기준에서 재검증 |
| **Stop managing** (`unmanage`) | BoxSpec이 해당 generated screen output을 더 이상 덮어쓰면 안 됨 | generated unit 소유권을 manifest에서 제거하고 screen ID를 영속 기록; 이후 save는 사용자 파일을 보존하되 contract JSON export는 계속 관리 |

세 선택 모두 Jobs의 명시적 사용자 동작을 요구한다. Drift 감지만으로 계약, baseline 또는 원본을 자동 변경하지 않는다. `propose-contract`는 contract export에만 사용할 수 있고 arbitrary TypeScript/React source에서 layout contract를 추론하지 않는다. 잘못됐거나 누락된 contract export는 import할 수 없으므로 `restore-contract`만 가능하다. `unmanage`도 generated output 전용이다.

선택 전 inspection의 file hash, ownership manifest hash 또는 approved revision이 바뀌면 runtime은 stale/conflict로 거절한다. Jobs를 새로 열어 다시 inspect하고 현재 상태로 결정한다. Restore/import/unmanage는 native durable batch와 manifest-last 갱신을 사용한다.

`.boxspec/generated-manifest.json`이 없으면 현재 approved contract와 generated intent를 기준으로 inspection할 수 있다. Manifest가 JSON/schema/path/hash 기준에서 손상됐으면 `APPLY_CONFLICT`로 fail-closed하며 자동 복구 선택을 제공하지 않는다. Manifest나 managed file을 추측해 직접 고치지 말고 backup과 현재 파일을 보존한다.

## Rebaseline과 재검증

1. 의도된 원본 상태와 계약 변경을 먼저 확정한다.
2. 새 base commit/manifest와 관련 파일 hash를 캡처한다.
3. dependency closure, 공용 component를 쓰는 화면, protected scope를 다시 계산한다.
4. 새 contract/policy/profile/fixture identity에서 새 candidate를 만든다.
5. 모든 required check를 다시 실행한다. 이전 screenshot, report ID, approval을 이어 쓰지 않는다.
6. 새 report가 PASS이면 trusted UI에서 전체 diff를 다시 검토하고 승인한다.

외부 에이전트에 원본 source 접근 권한이 있으면 BoxSpec은 앱 밖의 쓰기를 차단할 수 없다. 에이전트에는 staging/worktree만 쓰도록 설정하고 원본 권한은 제거하거나 읽기 전용으로 제한한다. worktree는 보안 sandbox가 아니다.

Desktop Jobs UI와 runtime에 위 세 동작이 연결돼 있다. Runtime strict TypeScript/build와 전체 13/13이 통과했고, 관리 export·generated output의 restore/import/unmanage 및 restart persistence를 다루는 targeted drift/Core import audit는 1/1, 25.50초로 통과했다. 이 동작은 현재 Electron 7/7 campaign에는 포함되지 않았고 clean installed app에서의 drift 조작도 아직 검증 전이다. 이전 candidate/report/approval을 재사용하지 않는 재검증 원칙은 그대로다. 현재 release 판정은 [P1 acceptance map](../p1-acceptance.md)과 [release checklist](../release-checklist.md)를 따른다.
