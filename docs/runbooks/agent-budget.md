# Agent budget 런북

## 기본 제한

BoxSpec의 기본 운영 정책은 implementer 1개와 독립 reviewer 1개, 같은 실패의 자동 수정 최대 2회다. style 후보 생성은 사용자가 선택했을 때 최대 3개다. project 구현 동시성 기본값은 2, verification browser 동시성 기본값은 1이다.

layout 편집, 계약 검사, geometry 계산과 local 17-preset 디자인 테마의 검색·preview·적용 자체는 LLM 토큰을 필요로 하지 않는다. LLM은 slot 구현, 기존 코드 이해, 새 style 후보와 실패 수정에만 사용한다. Catalog preset을 live draft에 적용해도 agent가 자동 실행되지 않는다.

AI가 보낸 live layout draft를 사용자가 drag/resize/delete/group하는 동안에는 agent를 매 동작마다 다시 실행하지 않는다. **이 배치로 구현**은 한 번의 명시적 구현 handoff를 만들 뿐 모든 외부 client를 자동으로 깨우지 않는다. Budget이 끝났으면 draft와 새 계약 revision은 보존하되 구현 task, candidate 생성과 원본 apply를 자동 시작하지 않는다.

## budget 초과 시

1. 새 agent 실행과 새 후보 생성을 중단한다.
2. 현재 staging, frozen candidate, report, artifact와 evidence를 보존한다.
3. 진행 중인 원본 apply를 자동 시작하지 않는다. budget 초과는 승인이나 PASS가 아니다.
4. 마지막 실패 signature, 시도 횟수, 사용된 candidate/report ID와 남은 미검증 범위를 표시한다.
5. 사용자가 범위를 줄이거나 budget을 새로 승인하면 기존 candidate를 수정하지 말고 staging에서 새 candidate를 만든다.

같은 실패를 세 번째 자동 수정으로 넘기지 않는다. 입력·환경이 실제로 달라져 실패 signature가 바뀌었는지 사람이 확인한 뒤 새 시도로 취급한다. 예를 들어 browser 부재나 stale revision은 코드를 반복 수정할 문제가 아니다.

## 사용량 표시

- provider가 실제 usage를 보고한 경우에만 실제 토큰 수로 표시한다.
- usage를 제공하지 않으면 `미제공`으로 표시한다. 0으로 기록하지 않는다.
- 비용을 추정하면 사용한 단가와 `추정`임을 함께 표시한다.
- 구독형 client 사용량을 정확한 달러 API 비용으로 환산했다고 주장하지 않는다.

## 재개 전 점검

- candidate/report가 여전히 같은 contract, policy, profile, fixture, source baseline에 묶여 있는지 확인한다.
- 변경이 있으면 이전 report를 STALE로 처리하고 새 candidate를 검증한다.
- 실패가 deterministic violation이면 violation과 node/viewport/fixture를 구현자에게 좁혀 전달한다.
- `UNVERIFIED`/`ERROR`이면 환경부터 복구한다. 자동 코드 수정 횟수로 소비하지 않는다.
- 새 PASS가 생겨도 trusted UI 검토와 사용자 승인을 건너뛰지 않는다.

현재 구현이 provider usage, 비용 추정, 동시성 제한 또는 자동 retry counter를 노출하지 않으면 해당 값은 미구현/미제공이다. 수동 운영에서는 시도 ID와 횟수를 기록해 기본 최대 2회를 지킨다.
