Yalla Journey — Bot ATTACK / RAID & Notification DEV Implementation Brief
작성일: 2026-11-19 · 대상: Codex · 범위: DEV only · 상태: 확정 규칙 + 미결정 항목 분리
0. 목표와 용어 (절대 혼동 금지)
- ATTACK = Village 건물 파괴. 공격 대상의 건물 레벨을 낮추고 피해 상태(빨간 표시)를 남긴다. YP를 약탈하지 않는다.
- RAID = 대상 플레이어가 보유한 Yalla Point(YP) 약탈. 건물 레벨과 월드 진행도를 변경하지 않는다.
- ATTACK 복구 비용 50% = 피해 유저가 파괴된 건물을 복구할 때 부담하는 비용. RAID의 약탈률이 절대 아니다. 현재 코드의 '선택한 업그레이드 비용의 50%, 올림' 산식을 기준으로 검토하되 실제 레벨 하락 후 어느 레벨의 업그레이드 비용을 참조하는지 일관되게 정한다.
- 유저→봇 기존 가방 선택 RAID 보상과 봇→유저 실제 지갑 약탈 RAID는 별개의 흐름이다. 기존 보상/티켓 정산을 훼손하지 않는다.
1. DEV에서 확인된 현황 (2026-11-19 조사)
- yalla-dev-incoming-raid Lambda가 EventBridge rate(1 minute)로 호출되며 실제 기능은 봇→유저 ATTACK이다. 함수명 incoming-raid를 행동 종류의 근거로 사용하지 말 것.
- bots.json: enabled=true, targetOffline=true, devFastMode=true. 봇 10개 중 player_1001만 attackEnabled=true.
- 후보는 마지막 활동 5분 초과~24시간 이하인 유저. dueAt, PROFILE, COLLECTION 및 방패가 없을 때 PROGRESS 등의 조건 존재.
- 최근 조사 24시간: 시설 파괴 0건, 명시적 ATTACK 방어 2건, 이전 형식 방패 소모 4건. Lambda 호출 2,196회 중 오류 1,490회.
- 핵심 오류: PROGRESS.distance, lastDistanceMilestone, constructionStars의 DynamoDB Number를 문자열 스키마로 검증하여 expected string, received number. 기존 정상 읽기 경로의 변환을 재사용할 것.
- 현재 ATTACK은 PROGRESS.villageDamage를 기록하지만 실제 건물 레벨 하락은 확인되지 않음. 레벨 데이터/복구/UI를 함께 검증해야 한다.
- 봇→유저 실제 YP RAID 미구현. 기존 유저→봇 가방 RAID는 보상을 지급하는 별도 로직.
- Ranking Popup ACTIVITY UI는 존재하나 서버 수신 기록/읽음 배지 연결은 미확인. iOS 원격 푸시 등록은 비활성이고 capability를 제거하는 빌드 후처리가 있음. Ops Telegram은 일부 ATTACK 이벤트만 처리하고 중복 방지 미완성.
2. 공통 봇 실행 조건 및 설정
1. 기본 실행 주기 15분으로 변경. EventBridge 스케줄 실행 간격과 유저별 쿨다운을 서로 다른 설정으로 관리. 15분은 봇 시스템 전체의 스케줄러 실행 간격이며, **유저별 쿨다운은 DEV에서 0분(미적용)**으로 확정한다. 같은 유저가 다음 실행에 다시 선정될 수 있다.
2. 공격 대상 조건: 마지막 활동 후 5분 초과~24시간 이하 유지. 활동 시간은 서버 기준으로 판정. 정확한 경계값 테스트.
3. bots.json 등 기존 DEV 설정 체계 재사용. enabled, attackEnabled, raidEnabled, scheduleMinutes, offlineMinMinutes, offlineMaxHours, perPlayerCooldownMinutes(DEV 기본 0), dailyLimit(DEV 미적용), attackRaidWeights, targetAllowlist, devFastMode 등 기존 필드와 호환되는 설정 구조 제안. 새 필드/기본값은 스키마 검증과 함께 명시.
4. DEV에서는 유저별 일일 공격 상한도 적용하지 않는다. 단, 15분 스케줄 1회당 실행 건수와 동시성은 기존 코드 동작을 확인하고 별도로 기록한다. 격리 테스트 계정으로 먼저 검증한다.
5. 설정 변경만으로 행동별 활성화, 시간대, 대상 조건, 확률/가중치, 쿨다운/상한을 조정할 수 있도록 설계. 실제 EventBridge rate 변경에는 인프라 반영이 필요하다는 점 문서화.
6. 같은 대상에 대한 중복 실행/재시도는 eventId, dueAt, 상태 버전 및 조건부 트랜잭션으로 방지. 스킵/오류 사유를 관측 가능하게 기록.
3. ATTACK — 건물 파괴 (구현 승인 범위)
- 봇이 오프라인 조건을 만족하는 유저의 현재 Village 시설 하나를 공격한다.
- 방패가 있으면 방패 1개 소모, 시설 레벨/피해 변화 없음, BLOCKED 이벤트 기록.
- 방패가 없으면 대상 시설의 업그레이드 레벨을 1단계 낮추고 villageDamage 또는 호환 피해 상태를 저장하여 빨간 파괴 표시가 게임에 나타나게 한다. HIT 이벤트 기록.
- 시설 레벨 하한 Lv.1, World 및 Village 위치는 절대 후퇴하지 않음. 완료/다음 월드 이동/저장 초기화 규칙을 훼손하지 않는다.
- 이미 피해 상태인 시설 재공격, Lv.1 시설만 남은 경우, 모든 시설이 피해 상태인 경우에는 중복 차감 없이 안전하게 스킵하거나 다른 유효 시설을 고른다. 정확한 후보 정책은 현재 동작을 우선 분석하여 제안하고 테스트한다.
- 피해 유저가 복구할 때 복구 비용은 해당 건물의 잃은 1단계를 되돌리는 업그레이드 비용의 50%(올림). 비용은 피해 유저의 YP에서 차감하고 해당 시설 레벨과 빨간 피해 표시를 원자적으로 복원한다. 재시도·중복 복구로 이중 차감 금지.
- 공격 자체는 YP를 훔치지 않으며, 봇에게 YP를 적립하지 않는다.
- 기존 PROGRESS Number↔string 변환 오류를 수정하고 데이터 정밀도, 시설 레벨, 피해 플래그, 복구 비용, Unity 표시까지 종단 검증.
4. RAID — YP 약탈 (설계 및 미결정 사항 확인 후 구현)
- 봇→유저 RAID는 대상의 실제 보유 YP를 차감하는 별도 서버 정산. ATTACK 시설 피해와 혼용 금지.
- 앞서 요청된 **'전체 밸런스의 5~10%, 주머니당'**은 RAID 경제 규칙 후보로 기록한다. 주머니 개수, 각 주머니의 기준 잔액, 선택 횟수, 성공/실패, 최대 약탈액, 잔액 보호, 반올림은 미결정. Codex가 임의로 공식 확정하거나 DEV에서 실제 약탈을 활성화하지 말 것.
- 공격 주기 15분 및 오프라인 대상 5분 초과~24시간 이하를 공통 기본 조건으로 재사용한다. 유저별 쿨다운 0분, DEV 일일 공격 상한 없음을 ATTACK/RAID에 공통 적용한다. ATTACK/RAID 선택 비율은 별도 승인.
- 기존 유저→봇 가방 RAID(보상 지급, 티켓 차감)는 현행 동작 유지. 봇→유저 지갑 약탈과 구분된 이벤트 타입·경제 영수증 필요.
- 원자적 YP 차감, 잔액 음수 방지, 이벤트 ID 중복 방지, 대상/공격자 계정 정합성, 실패 시 무정산 필수.
5. 알림 통합 — 정산 성공 후만
공통 이벤트 계약: eventId, eventType (ATTACK/`RAID`), actorType, actorId, targetType, targetId, targetPlayerId, result, worldId, villageId, facilityId, levelBefore, levelAfter, stolenYP, shieldConsumed, occurredAt. 기존 영수증 호환 어댑터 사용. stolenYP는 실제 상대 지갑 차감액에만 사용, 가방 보상은 rewardYP로 구분.
- 게임 내 Activity: 기존 Ranking Popup의 ACTIVITY 탭에 받은 ATTACK/RAID 최신순 표시, 공격자/봇·피해/방어·상대 시간·읽음 상태·배지. 같은 이벤트 중복 표시 금지. 본인이 실행한 공격 결과는 기존 결과 UI 유지.
- iOS 원격 푸시: 피해 유저에게 ATTACK 시설 피해/방패 방어, RAID 실제 약탈/방어만 발송. APNs 기기 토큰 등록/보관/무효화, 환경 분리, 탭 시 ACTIVITY 진입. 현재 capability 제거 후처리 점검. 비밀 키는 안전한 저장소에만 저장.
- ENERGY FULL: 자연 충전 12분당 1, 50 도달 시 iOS 로컬 알림. 보상으로 50 초과 가능. 소비/지급/재접속 시 예약 재계산·취소. 앱 종료 중 예약 알림, 다중 기기 동기화 한계 문서화.
- 운영 Telegram: 기존 yalla-dev-ops, 관리자 개인 채팅 및 /botstats 유지. ATTACK/RAID와 봇→유저·유저→봇·유저→유저 구분, 피해/방어/금액/시설 정보 표시. 기존 설정·토큰 노출 금지. 이벤트 중복 발송 방지.
- 알림 실패는 게임 정산을 롤백하거나 재실행하지 않는다. 확정 이벤트를 비동기 처리하고 채널별 발송 상태 기록.
6. Codex 실행 순서
1. 이 문서를 yalla-backend/docs/의 정책 기준으로 저장하고 기존 소스/DEV 설정과 대조. 미결정 정책은 질문 목록으로 분리.
2. ATTACK의 PROGRESS 파싱 오류 수정, 시설 레벨 하락/빨간 표시/복구비 50% 구현, 로컬 단위·통합 테스트.
3. 15분 기본 스케줄, 5분 초과~24시간 이하 대상 유지, 유저별 쿨다운 0분 및 DEV 일일 상한 미적용, 설정 유연화, Fast Mode 영향/스킵 계측. 기존 dueAt이 의도하지 않은 유저별 쿨다운으로 작동하지 않도록 점검하되 중복 트랜잭션 방지용 안전장치는 유지. DEV 격리 대상 검증 후 DEV 배포.
4. 공통 확정 이벤트 및 Activity 서버/Unity 연결, Telegram 확장·중복 방지.
5. APNs 원격 푸시 및 ENERGY FULL 로컬 알림 연결.
6. RAID 약탈 공식·보호 정책을 사용자에게 확정받은 후 봇→유저 RAID 구현/DEV 검증. 기존 가방 RAID 회귀 테스트.
7. 필수 검증
- 방패 있음: 방패만 1 감소, 레벨 불변. 방패 없음: 건물 Lv.3→Lv.2, 빨간 표시, World/Village 불변. Lv.1: 1 미만으로 하락하지 않음.
- 복구: 잃은 단계의 업그레이드 비용 × 50%(올림)만 피해 유저에게 청구, 레벨 원복, 빨간 표시 제거, 이중 청구 없음.
- 15분 실행 및 5분/24시간 경계, 대상 없음, 누락 데이터, 모든 건물 피해, 중복 스케줄, 재시도/스킵 로그.
- 기존 유저→봇 RAID 가방 보상·티켓·코스튬 포인트 불변.
- Activity·Telegram·APNs는 정산된 이벤트당 한 건만 처리. 푸시 실패해도 경제 정산 불변.
- PROD 미접근/미변경, DEV 테스트 범위 명시, 배포 전/후 Lambda 오류·영수증 비교.
8. 아직 사용자 결정이 필요한 항목
1. ATTACK/RAID 선택 비율(예: 독립 실행인지 가중치 선택인지).
2. 출시(PROD) 전 유저별 쿨다운 및 일일 공격 상한 재검토(DEV에서는 둘 다 미적용). 연속 ATTACK/RAID 제한 여부는 미결정.
3. RAID '주머니당 5~10%'의 주머니 수·계산 기준·성공 규칙·총 약탈 상한.
4. RAID 방어/실패 규칙, 약탈 YP의 봇 적립 또는 소각.
5. 신규 유저 보호, Lv.1/모든 시설 피해 시 공격 스킵 정책.
6. 알림 빈도 제한과 야간 알림 정책.
주의: 이 문서는 구현 명세다. 현재 실제 DEV에 반영되었다고 간주하지 않는다. 미결정 경제 규칙은 임의 구현 금지.

## DEV 실행 정책 확정 및 로컬 반영

- EventBridge는 15분마다 시스템 전체를 1회 호출한다. 한 슬롯에서 성공 또는 방패 방어를 최대 1건 커밋한다. EventBridge 이벤트의 예약 시각과 전역 조건부 슬롯 기록으로 지연 재시도와 동시 실행의 중복 커밋을 막는다.
- ATTACK과 향후 활성화될 RAID는 서버 활동 시각 기준 5분 초과~24시간 이하의 오프라인 후보를 공유한다. ATTACK은 Village 시설 피해, RAID는 대상 YP 약탈이다. 기존 유저→봇 가방 RAID 정산과 방패 규칙은 현행대로 적용한다.
- DEV 유저별 쿨다운은 0분이며 일일 상한은 없다. 같은 유저는 다음 슬롯에 다시 선정될 수 있다. 과거 dueAt와 일일 카운트는 이 정책에서 대상 제외 사유가 아니다. 일정 레코드의 버전과 순번은 중복 정산 방지에 계속 사용한다.
- DEV의 새 정책은 기존 Fast Mode와 함께 사용할 수 없다. 이전 설정과의 호환 경로는 유지한다. 새 정책의 전역 슬롯 제한은 유저별 제한과 독립적이다.
- 설정 위치는 `config/dev/bots.json`의 `offlinePolicy`다. `scheduleMinutes=15`, `offlineMinMinutes=5`, `offlineMaxHours=24`, `perPlayerCooldownMinutes=0`, `dailyLimit=null`이다. 활동 하한은 제외하고 상한은 포함한다. 실행 주기 변경 시 설정과 EventBridge 템플릿을 함께 반영한다. 쿨다운 및 일일 상한을 향후 활성화할 경우 각각 마지막 확정 시각과 UTC 일별 정산 수를 사용한다.
- 위 값은 로컬 설정 기준이다. DEV 배포와 격리 계정 검증은 별도다. 실제 YP RAID는 경제 규칙과 행동 선택 비율이 확정될 때까지 비활성 상태다.

## DEV 배포와 경제 정책 업데이트 · 2026-11-19

### 설정과 전개

- `config/dev/bots.json`이 DEV 운영 정책의 단일 원본이다. `infra/generate.py`가 `offlinePolicy.scheduleMinutes`로 CloudFormation Rule 표현식을 생성한다. `scripts/deploy.py`는 파일 스키마와 생성된 표현식의 일치를 확인하고, 같은 설정을 S3 `game-config/dev/v1/bots.json`에 발행한다. 배포 후 Rule 주기, 직접 대상 Rule과 Scheduler, S3 설정 및 Lambda 코드 SHA를 다시 조회한다. 격리 검증 때만 배포 인자로 생성된 테스트 계정 허용 목록을 적용한다.
- CloudFormation `yalla-dev-bundle1`에서 기존 Rule ARN `arn:aws:events:ap-south-1:533266967583:rule/yalla-dev-bundle1-IncomingRule-uDwJ6eml1eGY`를 재사용했다. 활성 규칙의 최종 주기는 `rate(15 minutes)`다.
- DEV의 현재 행동 가중치는 `ATTACK=1, RAID=0`이다. 이는 배포 상태를 표현한다. 두 행동을 활성화할 때의 혼합 비율은 아직 결정되지 않았다.

### ATTACK

- DynamoDB `PROGRESS` 숫자 필드의 정밀도를 보존하며 공통 변환으로 읽고 Number로 저장한다. 방패가 있으면 1개를 차감하며 시설은 유지한다.
- 방패가 없으면 미피해 상태의 Lv.2 이상 시설 하나를 한 단계 낮춘다. Lv.1 시설과 완료된 World는 레벨 하락 대상에서 제외한다. 현재 World, Village, 실행 ID, 완료·해금 상태, 건설 별은 유지한다. 기존 `villageDamage.buildings`에 공격 ID를 남기고 새 피해에 한해 `levelsBefore`를 부가 저장한다. 기존 Unity 피해 표시 입력과 영수증 필드가 유지된다.
- 복구는 잃은 단계의 업그레이드 비용 × 50%를 올림하고, YP 차감, 레벨 복구, 피해 제거와 경제 영수증을 원자적으로 기록한다. 레벨 하락 없이 피해만 저장했던 이전 데이터는 기존 복구 비용과 레벨 유지 동작을 따른다.
- 확정 ATTACK은 대상과 순번을 포함하는 `eventId`, 공격자·대상 유형과 ID, 발생 시각, 결과, 시설 및 레벨 정보를 정산 트랜잭션의 기존 영수증에 함께 기록한다. 방어 영수증의 시설 필드는 해당 사항이 없다. Streams 알림은 확정 이후 별도로 처리된다.

### RAID — 확정 정책과 구현 보류 항목

- RAID 시작 시점에 조회한 실제 지갑 YP 중 50%를 보호하고, 선택으로 실제 획득한 YP만 최대 시작 잔액의 50%까지 차감한다. 차감분은 소각하며 봇 지갑은 만들지 않는다. 보호 비율 설정은 `walletRaid.protectedBalanceBps=5000`이다. 실제 지갑 차감 정산이 마련될 때까지 `walletRaid.enabled=false`이며 스키마도 활성화 설정을 거부한다.
- 기존 유저 → 봇 가방 RAID는 5개 중 당첨 3개를 무작위 배치하고 3개를 고르게 한다. 당첨 가방은 각각 100~300 고정 범위의 YP 보상, 나머지 2개는 0이며, 정산 상한은 900이다. 이 구조는 대상 잔액 보호분을 나누는 공식이나 작은 풀에서의 당첨 금액 보정 기준을 제공하지 않는다.
- **구현된 봇 → 유저 약탈 주머니 배분 공식은 없다.** 다음 결정은 가변 풀을 당첨 주머니에 나누는 방식과 작은·홀수 잔액의 정수 배분, 정산 전 잔액이 줄었을 때 전체 취소와 부분 지급 중 적용할 방식, ATTACK과 RAID의 혼합 비율이다. 기존 유저 → 봇 보상과 티켓 정산은 유지한다.
- Activity, APNs, Telegram 확장과 봇 → 유저 RAID 정산은 이 배포에서 제공하지 않는다.

### 변경 파일

- 설정 및 배포: `config/dev/bots.json`, `infra/generate.py`, 생성된 `infra/bundle1.json`, `scripts/deploy.py`
- 실행 및 저장: `src/bots-config.ts`, `src/incoming-raid.ts`, `src/model.ts`, `src/repository.ts`, `src/world.ts`
- 회귀: `tests/incoming-raid.test.ts`, `tests/world.test.ts`
- 배포 패키지에는 작업 트리에 있던 `src/bonus.ts`, `src/raid-bots.ts`의 기존 DEV 방패 재생 설정 정합 변경도 포함된다.

### AWS 실제 검증 결과

- 2026-11-19 07:38~07:39 두바이 시간에 최종 패키지를 `yalla-dev-incoming-raid`, `yalla-dev-player`, `yalla-dev-auth`에 배포했다. 세 함수의 코드 SHA-256은 `UXIoPim8XmS1DZrwiD2Ox5bwDajB+h3+FTnLSjPoSmU=`로 읽어 확인했다. 기존 Rule은 ENABLED, 직접 Lambda 대상 1개, 동일 Lambda를 가리키는 Scheduler 0개다. 기존 1분 규칙은 별도 리소스로 남아 있지 않다.
- 격리 게스트로 07:37 두바이 시간 같은 슬롯의 병렬 Lambda 호출을 실행했다. `BLOCKED` 영수증 1건, 방패 1→0, 시설 Lv.3 유지, 100 YP 유지였다. 다음 슬롯 07:45에 동일 게스트의 `HIT` 영수증 1건이 생겼다. 건물 1이 Lv.3→2로 하락했고 기존 Unity 오버레이가 사용하는 피해 데이터 및 새 `eventId`가 저장됐다. World, Village, 실행 ID, 건설 별, 공격 전후 100 YP는 유지됐다.
- 실제 World API의 업그레이드 비용은 10 YP, 복구 견적은 5 YP였다. 같은 요청 ID로 병렬 복구를 호출해 한 번만 5 YP가 청구됐고 Lv.3과 피해 없는 상태가 복원됐다. 피해의 실제 iOS 화면 렌더링은 미검증이다.
- 같은 격리 계정에서 기존 유저→봇 가방 RAID API를 실행했다. 5개 중 3개 선택의 보상은 284, 0, 132 YP였으며 총 416 YP, 코스튬 포인트 2, 티켓 1장 차감을 확인했다. 마지막 선택 재시도는 보상을 중복 지급하지 않았다.
- 최종 배포 시각 이후 검증 구간 CloudWatch에서 worker REPORT 2건 및 Player API REPORT 9건을 확인했다. `ZodError`, 설정 로드 오류, 호출 오류는 0건이었다. 검증은 격리 계정의 실제 Lambda/HTTP 호출을 포함했다. 운영 복원 뒤 장기 오류율은 미검증이다.
- 07:51 두바이 시간에 검증용 허용 목록을 제거하고 운영 `bots.json`을 다시 게시했다. 다운로드한 S3 객체가 로컬 원본과 바이트 단위로 일치하며 기존 Rule이 ENABLED 및 15분임을 재확인했다.
- 로컬 타입 검사, 빌드, 전체 회귀 테스트 120개가 통과했다. IaC 생성기에 1·7·15분 설정을 각각 넣어 DEV 표현식만 변경되는 것도 확인했다. PROD에는 접근하거나 배포하지 않았다.

## 봇 → 유저 RAID 최종 정책 · 2026-11-19

이 절이 앞선 미결정 및 ATTACK 전용 배포 기록 이후의 최종 정책이다.

- 운영 원본은 `config/dev/bots.json`의 `offlinePolicy`다. `attackRaidWeights`에 `ATTACK=1, RAID=1`을 적용한다. 각 15분 실행에서 예약 이벤트 ID에 기반한 균등 난수를 가중치 합계에 적용해 한 행동을 선택한다. 같은 예약 이벤트를 재시도할 때 입력 가중치가 같으면 같은 행동을 선택한다. 가중치는 설정 배포로 바꾼다. 처리 가능한 후보가 없으면 해당 실행은 건너뛰며, 다른 행동으로 바꾸지 않는다.
- 기존 오프라인 범위(5분 초과~24시간 이하), 유저별 쿨다운 0, 일일 상한 없음, 다음 슬롯 재선정을 유지한다. 두 행동은 동일한 전역 슬롯 트랜잭션을 공유한다. 한 슬롯에서 확정되는 결과는 최대 하나다.
- `walletRaid.enabled=true`, `protectedBalanceBps=5000`, `bagWeightsBps=[2000,2000,1000,0,0]`이다. 양수 주머니 세 개 각각에 시작 잔액 × 비율을 내림하고, 꽝 두 개를 포함해 섞은 뒤 서로 다른 인덱스 세 개를 고른다. 내림 잔여분은 그대로 지갑에 남는다. 주머니 비율 합은 설정상 약탈 한도를 초과할 수 없다.
- 실제 차감액은 `min(선택 주머니 합계, floor(정산 직전 잔액 × (10000 - protectedBalanceBps) / 10000))`이다. 지갑 버전이 충돌하면 최초 주머니와 선택을 유지한 채 최신 잔액으로 한도를 다시 계산한다. 차감분은 소각하며 봇 잔액은 만들지 않는다. 차감액 0은 MISS다. 시설 ATTACK의 방패 방어와 건물 정산은 유지한다. YP RAID는 시설·방패·티켓을 변경하지 않는다.
- 지갑, 공통 진행 순번, 슬롯 잠금, 불변 RAID 영수증을 DynamoDB 한 트랜잭션으로 기록한다. `RAID:<대상 ID>:<순번>`과 조건부 키로 재실행에 의한 이중 차감을 막는다. 영수증 키는 `INCOMING#WALLET_RAID#<순번>`이며 시작/정산 잔액, 가방 배치, 선택, 실제 차감 및 소각 정보를 담는다. `GET /bonuses`의 `incomingActivity`는 확정 ATTACK·RAID를 함께 노출하고, 기존 `incomingRaid` 호환 응답은 유지한다. 기존 Telegram ATTACK 필터는 지갑 RAID 영수증을 ATTACK으로 오인하지 않는다. 별도 Unity Activity UI 및 APNs·Telegram 신규 연동은 범위 밖이다.
- 변경 파일: `config/dev/bots.json`, `src/bots-config.ts`, `src/incoming-raid.ts`, `src/incoming-wallet-raid.ts`, `src/repository.ts`, `src/bonus.ts`, `tests/incoming-raid.test.ts` 및 이 문서. 기존 배포 스크립트와 단일 EventBridge Rule을 재사용한다.

### 최종 RAID AWS DEV 배포 및 실측

- 2026-11-19 08:07:38 두바이 시간에 `yalla-dev-incoming-raid`, `yalla-dev-player`, `yalla-dev-auth`에 SHA-256 `v0umvYIiM5WoiHAUobLv2cobCZ/4xwMr0cSViD713R4=` 번들을 배포했다. Rule ARN은 `arn:aws:events:ap-south-1:533266967583:rule/yalla-dev-bundle1-IncomingRule-uDwJ6eml1eGY`이며 `ENABLED`와 `rate(15 minutes)`를 확인했다. 대상 Rule 1개, Rule 내 Lambda 대상 1개, 별도 Scheduler 및 직접 이벤트 소스 매핑 0개다.
- 격리 게스트 `1474904f-3d57-4453-afa4-02d4aa3c7d42`에서 08:08:29에 `RAID:1474904f-3d57-4453-afa4-02d4aa3c7d42:1`을 확정했다. DynamoDB 키는 `INCOMING#WALLET_RAID#0000000000000001`이다. 시작 및 정산 직전 107 YP, 주머니 배열 `[0,21,21,0,10]`, 선택한 주머니 금액 `[0,21,0]`, 차감·소각 21 YP, 최종 86 YP다. 동일 예약 이벤트를 두 번 병렬 호출하고 한 번 더 재실행해 영수증과 Activity가 각각 1건이고 추가 차감이 없음을 확인했다. 시설·진행도와 방패 1개는 유지됐다.
- 같은 계정에서 기존 유저 → 봇 가방 RAID 보상 197 YP, 코스튬 포인트 1, 티켓 1장 차감, 중복 지급 0을 실제 API로 확인했다. 후속 ATTACK은 Lv.3→2와 기존 진행도 유지를 확인했다. 처음 복구 요청은 기존 보너스 세션이 아직 열린 상태여서 HTTP 409였다. 세션을 표준 API로 확인·종료한 후 동일 복구 요청을 두 번 병렬 실행하자 5 YP만 한 번 차감되고 Lv.3과 피해 없는 상태가 복원됐다. 방패 방어는 이전 AWS 격리 검증 및 이번 전체 로컬 회귀에 포함됐다.
- 검증 구간 Lambda CloudWatch에서 `ATTACK=1, RAID=1`로 로드한 두 분기 모두 관측됐다. 작업자 REPORT 6건과 플레이어 REPORT 16건에서 Lambda 오류·ZodError·봇 설정 로드 오류 0건이다. 분기 검증은 동일 1:1 설정에서 분기별 예약 이벤트 ID를 사용한 실제 Lambda 호출로 진행했다. 운영 장기 분포는 미측정이다.
- 타입 검사, 빌드, 전체 자동 테스트 122개가 통과했다. 정산 중 잔액 107→1 변경 시 최초 주머니를 유지하고 실제 차감이 0이 되는 케이스는 로컬 충돌 회귀로 검증했다.
- 08:16:30에 격리 허용 목록을 제거했다. DEV S3 파일과 로컬 원본의 바이트 일치, RAID 활성·가중치 1:1, Rule 15분 활성 상태를 다시 확인했다. PROD에는 접근하거나 변경하지 않았다.
