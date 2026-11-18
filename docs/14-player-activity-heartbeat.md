# Unity heartbeat와 자동 RAID 대상

Unity는 기존 Cognito **access token**을 사용해 `POST /players/me/heartbeat`를 호출한다. 요청 본문은 생략하거나 `{}`를 보낸다. 성공 응답은 본문 없는 `204 No Content`다. 클라이언트 시각과 플레이어 ID는 전송하지 않는다.

- 플레이어 등록과 인증이 끝나고 앱이 포그라운드 상태일 때 즉시 호출한다.
- 포그라운드 동안 실제 경과 시간 기준으로 약 120초마다 호출한다. 게임의 타임스케일과 독립된 타이머를 사용하고 요청이 진행 중이면 중복 호출을 피한다.
- `OnApplicationPause(true)`에서 타이머를 중단한다. `OnApplicationPause(false)`에서 인증 상태를 확인하고 즉시 호출한 뒤 120초 타이머를 다시 시작한다.
- `401`이면 기존 Cognito 갱신 경로를 사용하고 앱이 포그라운드인 경우 한 번 다시 시도한다. 네트워크 오류와 `429`는 다음 주기에 재시도한다.

인증된 게임 API 요청도 동일한 활동 레코드를 갱신한다. 서버가 기록한 UTC 시각을 기준으로 5분 이내는 온라인, 5분 초과~24시간 이내는 공격 후보, 24시간 초과 또는 활동 기록이 없으면 제외한다. Heartbeat는 방패, 재화, 진행도에 접근하거나 변경하지 않는다.

`bots.json`에서 `incomingRaid.targetOffline: true`와 빈 `allowedPlayerIds`를 사용하면 최근 오프라인 후보 조회가 활성화된다. `incomingRaid.enabled`로 RAID를 끌 수 있다. 전환 시 CloudFormation에서 `PlayerActivity` 인덱스가 `ACTIVE`인지 확인한 뒤 DEV S3 설정을 게시한다. 기존 플레이어는 첫 인증된 게임 요청 또는 heartbeat부터 후보가 될 수 있다.
