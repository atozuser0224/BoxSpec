# 원본 적용과 crash 복구 런북

> 현재 상태: Windows native safe-fs helper와 change-manager의 실제 apply·restart recovery 시험은 통과했다. 다만 packaging copy/hash/signature와 설치본 E2E가 끝나지 않아 출시 운영에는 사용할 수 없다. 아래 절차는 개발 소스의 구현 계약과 복구 판단 기준이다.

## 적용 전

원본 적용은 trusted 데스크톱 UI의 사용자 승인으로만 시작한다. MCP에는 승인·잠금 해제·원본 적용 도구가 없다.

승인 화면에서 다음 값이 같은 검토 대상을 가리키는지 확인한다.

- candidate ID와 tree hash
- report ID와 `PASS`
- contract revision/hash, effective contract hash, override hash
- policy/profile/fixture/base source identity
- 변경 파일, 공간 diff, blocking violation 없음

BoxSpec은 적용 직전 원본 branch/HEAD와 관련 파일 hash, 새 파일 충돌, root identity, 권한과 디스크 공간을 다시 검사해야 한다. 하나라도 기준과 다르면 첫 원본 변경 전에 `APPLY_CONFLICT` 또는 stale로 멈춘다.

## 정상 적용

1. trusted UI에서 검토한 동일 candidate/report를 승인한다.
2. BoxSpec이 durable journal과 각 파일의 before/after hash 및 backup 위치를 준비할 때까지 기다린다.
3. 적용 중 앱, 원본 파일, journal 또는 backup을 직접 변경하지 않는다.
4. 모든 파일의 최종 hash가 검증 candidate와 같아 `APPLIED`가 된 뒤 결과를 확인한다.
5. Git commit/push는 별도 사용자 작업이다. BoxSpec 적용 성공이 commit이나 push를 의미하지 않는다.

여러 파일 적용은 filesystem 차원의 원자 transaction이 아니다. journal을 이용해 복구 가능한 순차 교체다.

## 비정상 종료 후

앱을 다시 열면 recovery 목록에서 transaction ID와 파일별 상태를 확인한다.

| 분류 | 디스크 상태 | 안전한 의미 |
|---|---|---|
| `BEFORE` | journal에 기록된 적용 전 hash와 일치 | 아직 이 transaction의 변경이 적용되지 않음 |
| `AFTER` | 검증 candidate의 적용 후 hash와 일치 | 이 transaction의 변경이 적용됨 |
| `UNKNOWN` | before/after 어느 hash와도 불일치 | 사용자 또는 외부 프로세스가 바꿨을 수 있음 |

모든 대상이 `BEFORE`/`AFTER`로만 분류되고 journal·backup·경로 identity가 유효할 때만 UI가 transaction 단위 resume 또는 rollback을 제안할 수 있다. recovery는 해당 transaction 파일만 다룬다.

`UNKNOWN`이 하나라도 있으면 자동 resume/rollback을 중단한다. 현재 change manager는 어떤 UNKNOWN도 쓰지 않고 source drift/manual intervention으로 남긴다. 해당 파일을 열어 현재 내용, before backup, candidate after를 비교한 뒤 별도 명시적 복구 절차를 마련해야 한다. BoxSpec은 UNKNOWN 파일을 자동으로 덮어쓰거나 삭제해서는 안 된다.

다음 명령은 복구 수단으로 사용하지 않는다.

```text
git reset --hard
git clean
자동 stash
작업 트리 전체 복원
```

## 막힌 복구

- journal 또는 backup이 없거나 손상됨: `MANUAL_INTERVENTION`으로 유지하고 추정 rollback을 하지 않는다.
- 원본 root identity 또는 경로가 바뀜: 원래 승인한 프로젝트를 다시 연결해 identity를 확인한다.
- 파일 잠금/antivirus/디스크 부족: 원인을 제거한 뒤 같은 transaction의 안전 지점에서 재개한다. 일부 파일을 건너뛰어 APPLIED로 만들지 않는다.
- 적용 중 원본 수정: 해당 파일은 UNKNOWN으로 취급한다. 별도의 [source drift 절차](source-drift.md)도 수행한다.
- 보호 파일 삭제/변경이 후보에 포함됨: 적용을 폐기하고 새 candidate로 돌아간다.
- 새 파일의 parent directory를 만든 직후 파일 추가 전에 중단됨: 원본 파일 bytes는 보존되지만 intended directory가 빈 상태로 남을 수 있다. 이를 `APPLIED`로 해석하지 말고 journal recovery를 끝낸 뒤 directory가 비어 있고 더 이상 필요 없음을 별도로 확인한다.

현재 desktop UI와 runtime에는 journal hash·5분 nonce를 묶은 inspection과 BEFORE/AFTER/UNKNOWN 표시가 있다. 모든 파일이 BEFORE/AFTER일 때만 사용자가 transaction 전체에 `finish-after` 또는 `restore-before`를 명시적으로 선택할 수 있다. UI에 보이는 UNKNOWN별 finish/restore 항목은 change manager가 허용하지 않으므로 사용하지 않고 `preserve-current`로 BLOCKED 상태를 유지한다.

Native safe-fs helper는 최종 55/55와 실제 mutation/recovery/finalize 재현을 통과했다. Change manager는 31/31, native 3/3, 독립 native/path 27/27에서 missing managed directory 생성, public native apply의 정확한 bytes·cleanup과 replacement 직후 crash→restart→`AFTER` 분류→명시적 `restore-before`로 정확한 `BEFORE` 복원을 확인했다. Helper는 trusted config의 절대 경로와 고정 SHA-256으로만 선택하며 매 spawn 때 다시 hash한다. 자세한 결과는 [safe-fs evidence](../evidence/safe-fs.md)와 [change-manager evidence](../evidence/change-manager.md)에 있다.

Runtime integration 4/4도 trusted verifier `PASS`→desktop approval→parent가 없던 새 파일의 native apply를 포함해 통과했다. Change manager는 각 unique upsert parent 생성 의도를 file replacement 전에 journal에 기록한다. 그래도 directory 생성과 file add 사이의 process termination에서 빈 directory가 남을 수 있다는 위 복구 한계는 유지된다.

개발 소스의 canonical helper는 `crates/boxspec-safe-fs/bin/boxspec-safe-fs.exe`, SHA-256은 `13073da7eb37b5c67ec8eaa14a93121d2e74f4a64fe9f508e820367d79cf41d8`이다. 공유 native manifest가 설치본 상대 경로 `resources/native/boxspec-safe-fs.exe`와 이 identity를 고정한다. 사용자가 executable을 직접 호출하거나 project 입력으로 경로/hash를 바꾸지 않는다. Helper의 `preparedId`는 권한 토큰이 아니며 승인, grant, journal 결박은 runtime/change-manager가 담당한다.

남은 차단 항목은 Windows package가 helper를 의도한 위치로 복사하고 hash/signature를 고정하는지, 설치본에서 같은 apply/recovery가 통과하는지다. 이 검증 전에는 배포 환경에서 경로를 임의 지정해 우회하지 말고 journal/backup을 보존한다. [P1 acceptance map](../p1-acceptance.md)의 B11은 계속 출시 차단 상태다.
