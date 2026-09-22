# 완성된 BoxSpec으로 UI를 구현하는 에이전트용 지시문

이 지시문은 BoxSpec 앱과 MCP 서버가 실제로 구현·실행되고 프로젝트 pairing이 승인된 다음 사용한다. 아래 `<...>`는 앱이 실제 값으로 채워준다.

---

연결된 BoxSpec의 project `<projectId>`, screen `<screenId>`, revision `<revision>`, node scope `<nodeIds>`를 사용해 다음 작업을 수행하라.

작업: `<사용자 UI 변경 요청>`

처음에 `boxspec_get_capabilities`를 호출하고 타깃과 필요한 기능이 실제 제공되는지 확인하라. 이어서 `boxspec_get_context`로 지정 revision의 계약·토큰·바인딩·영향 범위를 읽어라. 오래된 대화나 screenshot으로 현재 구조를 추정하지 마라.

앱이 이미 task `<taskId>`를 만들었다면 `boxspec_get_task`로 그 task의 상태와 허용 작업 공간을 확인하라. task가 없다면 승인된 execution profile `<executionProfileId>`로 `boxspec_start_task`를 호출하라. 새 작업이 READY가 되기 전에 파일을 쓰지 마라.

코드 수정은 앱이 반환한 staging workspace에 한정하라. 원본 repo, 보호된 로직, generated layout shell, policy, verifier, baseline을 바꾸지 마라. 직접 파일 도구가 없는 환경에서는 `boxspec_propose_patch`로 staging 변경을 제안하라. 앱의 경로 보호를 우회하지 마라.

기존 공용 컴포넌트·에셋·이벤트 바인딩을 우선 사용하라. fixture 데이터를 실제 production 데이터로 대체하지 마라. hard 제약이 요구와 충돌하면 `boxspec_propose_contract_change`로 이유와 대안을 제시하고 현재 구조를 임의로 해제하지 마라.

작업 후 `boxspec_submit_candidate`로 후보를 고정하고 `boxspec_verify_candidate`를 호출하라. 작업 상태와 서버 report를 읽고 blocking 오류가 있으면 해당 후보를 덮어쓰지 말고 새 수정 후보를 제출하라. 같은 실패 자동 수정은 기본 2회 이내다. 판단이나 로그만으로 PASS를 선언하지 마라.

PASS report가 있는 정확한 candidate/report 조합만 `boxspec_request_review`로 사용자 승인 대기열에 보내라. 직접 승인·원본 적용·배포·commit/push하지 마라. 결과에는 실제 candidate ID, contract revision, 실행된 검증, 미검증 범위를 보고하라. 사용자 최종 승인은 BoxSpec UI에서 처리한다.
