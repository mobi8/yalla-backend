# Backend Bundle 2.1 — Jackpot / Raid / Collection / Journey Game Config

2026-11-17, Asia/Dubai. Backend `/Users/lewis/Developer/yalla-backend`, Unity `/Users/lewis/Developer/YallaJourney`.

## 완료 범위와 기준 상태

시작 시 Backend `555c933`, Unity `67083d5`, 양쪽 main의 origin/main과 차이 0/0을 확인했다. 기존 Bundle 2와 Unity의 미추적 백업/캐시/중복 문서는 보존했다. 이번 변경은 작업 트리에 있으며 추가 커밋/푸시는 실행하지 않았다.

기존 AWS dev Stack `yalla-dev-bundle1` 업데이트 성공. Cognito/PlayerTable/Result Pool을 재생성하거나 기존 Player 데이터를 초기화하지 않았다. S3에는 새로운 `game-config/dev/v1/` prefix에만 4개 파일을 조건부 생성했다. prod 설정을 업로드하거나 prod를 배포하지 않았다.

- API: https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com
- Region `ap-south-1`, Profile `yalla-dev`.
- PlayerTable `yalla-dev-bundle1-PlayerTable-1TPG03GJPKOHQ` 유지.
- Unity GUI, Unity Test Runner, Unity batch process, iPhone 빌드/실행을 하지 않았다.

## 기존 규칙 확인과 기획 차이

### Jackpot

`Assets/YallaDrop/Core/Data/JackpotWheelConfiguration.cs`와 `Resources/JackpotWheelConfiguration.asset`의 실제 6섹터 값을 사용했다. 확률 weight 총합 10,000, 순서대로:

| 섹터 | weight / 확률 | YallaPoint |
|---|---:|---:|
| 0 | 3500 / 35% | 100 |
| 1 | 2500 / 25% | 250 |
| 2 | 1800 / 18% | 500 |
| 3 | 1200 / 12% | 1000 |
| 4 | 800 / 8% | 2500 |
| 5 | 200 / 2% | 5000 |

기존 `SpinJackpot`은 티켓 1개 소비, 결과 확정, YallaPoint 지급을 먼저 저장한다. 휠 회전과 GET은 지급 이후의 연출/확인이다. 이 순서를 서버에서도 보존했다. 안전한 `crypto.randomInt(10000)`로 선택하며 Unity 난수를 사용하지 않는다.

### Raid

근거: `YallaJourneyPlayerStore.Raid.cs`, `RaidConfiguration.cs`, `RaidState.cs`, `ShelterUpgradeCosts.cs`, `RaidSceneTransition.cs`, `RaidSceneView.cs`.

- 고정 템플릿 6명(player_1001,1002,1003,1005,1006,1007), 별도 Cognito 계정/타인 Wallet 없음.
- Bot ID `bot:<World>:v<Village>:<templateId>`.
- **실제 코드의 차이:** World와 Village는 플레이어 진행을 미러링하지만 시설 레벨은 플레이어의 개별 레벨을 복사하지 않고 `InitialFacilityLevels=[1,1,1,1,1]`을 사용한다. 기존 봇은 Shield/버전을 유지한다. 이 동작을 바꾸지 않고 `levelSource=CONFIG_INITIAL`로 명시했다. 플레이어의 시설별 실제 레벨 미러링으로 임의 변경하지 않았다.
- 초기 봇 Shield 6개 모두 0. 따라서 현행 새 봇의 첫 공격은 성공한다. 별도 성공 확률은 없다.
- 대상 선택/변경/취소/준비는 무료. 시설 0..4 선택 시 티켓 1개를 소비한다.
- 봇 Shield가 있으면 1개 소비하고 보상 0. 없으면 해당 시설의 기존 업그레이드 비용 × Raid 배수.
- 현재 모든 유효 World/Village/시설/레벨에서 비용은 10, 배수는 10 → 성공 보상 100 YallaPoint. MAX 시설은 마지막 4→5 비용을 쓰며 현재 역시 10이다.
- 성공/실패 모두 완료된 공격이며 실패도 티켓을 소비한다. 시설 레벨을 깎거나 실제 다른 Player를 약탈하는 동작은 없다.
- 결과를 확정한 뒤 GET/실패 확인까지 ActiveRaid를 유지한다. GET은 추가 보상이 아니다. 배치 내 다음 공격은 기존 순서대로 다음 봇을 기본 선택한다.
- **플레이어 Shield를 공격하는 incoming Raid 처리 자체는 기존 구현에 없다.** 새로 만들지 않았다. 이번 방어 처리는 공격 대상 봇의 Shield다. 플레이어의 Collection Shield를 outgoing Raid에서 차감하지 않는다.

### Collection / Shield

최신 Unity `EmblemCollectionProgress.Confirm`과 Bundle 2 `drop-economy.ts`가 일치하는 규칙을 이전했다.

- Crown 3 → Jackpot 티켓 1.
- Y1 + A2 + L2 → Raid 티켓 1. 보관 상한 Y5/A10/L10. 초과 문자는 버리며 Energy 환불 없음.
- Star 5 → Energy 5.
- **Camel 5 → Shield 1. Collection Shield 발급 상한 3. 초과 Shield 1개당 Energy 3.**
- 과거 Camel 3 → Energy 30 규칙은 복원하지 않았다. `CamelEnergy=10`의 legacy deferred 설정도 현재 Camel 완성 지급 규칙에 사용하지 않는다.
- 수집 수량은 committed Energy(1~3)이며 예측 적중 배수를 곱하지 않는다.
- 별도 구매/명시적 grant로 보유한 상한 초과 Shield를 Collection 정산이 회수하지 않는다. 새 Camel 발급분만 남은 cap과 비교한다.

### Journey

코드 `ProgressionChestRewards.cs`와 Bundle 2는 **300m마다 Energy 20 반복 지급**이었다. 일부 과거 문서는 300m/Energy 50을 기록했고 30m는 Oasis landmark로 등장했으나 상자 정책으로 확인되지 않았다. 사용자가 이번 작업에서 **300m / Energy 20 반복 유지**를 명시적으로 확인했다. 그 값을 `journey-v1`에 반영했다.

## S3 Config 구조 / 운영

Bucket `yalla-result-pools-533266967583`의 기존 `result-pools/v1/`은 변경하지 않았다.

```text
game-config/dev/v1/collection.json  collection-v1
game-config/dev/v1/journey.json     journey-v1
game-config/dev/v1/jackpot.json     jackpot-v1
game-config/dev/v1/raid.json        raid-v1
```

공통 envelope:

```json
{"schemaVersion":1,"environment":"dev","version":"journey-v1","data":{
  "distancePerChest":"300","rewardType":"Energy","rewardAmount":20,"repeat":"REPEATING"
}}
```

- `src/game-config.ts`: 공통 Zod 검증, 파일별 Lambda 메모리 캐시 TTL 60초, 동시 갱신 Promise 공유.
- `ENVIRONMENT`와 JSON environment가 일치해야 한다. prod는 `game-config/prod/v1/...`만 읽으며 dev 파일로 fallback하지 않는다.
- 누락/접근/다운로드 실패 `503 GAME_CONFIG_UNAVAILABLE`, 잘못된 JSON/스키마 `503 GAME_CONFIG_INVALID`, 환경 미설정 `503 GAME_CONFIG_NOT_CONFIGURED`.
- 만료 뒤 잘못된 새 파일을 읽으면 이전 캐시로 무기한 fallback하지 않는다. 설정을 고치면 다음 읽기로 복구한다.
- 실제 파일 SHA-256을 `contentHash`로 기록한다. 새 Round는 Collection/Journey envelope 전체를 고정 저장하고, Jackpot 결과/Raid 준비도 사용 설정 전체를 보존한다. Config 변경이 이미 발급된 게임의 비용/보상을 바꾸지 않는다.
- Bundle 2에서 이미 발급됐지만 config 필드가 없는 Round는 최초 정산 시 유효한 현행 Config를 사용하고 결과/영수증에 고정한다. 확정된 기존 Round를 재계산하지 않는다.
- `scripts/publish_game_config.py`: 로컬 JSON을 실제 Zod로 검증한 뒤 최초 파일은 `If-None-Match:*`로 생성한다. 변경은 새 JSON version과 명시적 `--replace-etag`가 필요하다. 수정·추가 후 Lambda 재배포는 필요 없다.
- 예: `python3 scripts/publish_game_config.py --name journey --profile yalla-dev --replace-etag '<현재 ETag>'`.
- S3 자체 VersionId는 현재 bucket에서 반환되지 않았다. 논리 version, hash, 발급 시 저장한 전체 policy가 정산 근거다.

Config별 data는 저장소 `config/dev/*.json`에 포함했다.

- Collection: 각 required/rewardType/rewardAmount, letter maximum, ticket maximum/overflow, Shield maximum/overflow reward.
- Journey: 거리(정확한 decimal 문자열), Energy/YallaPoint 보상 종류, 수량, REPEATING/ONCE.
- Jackpot: 6 weights, rewards, ticketCost, rewardType.
- Raid: ticketCost, multiplier, shieldMaximum, initialFacilityLevels, initialShieldCounts, eligibleUpgradeCost, levelSource, shieldRule, 템플릿 참조.

현재 UI와 규칙을 지키기 위한 검증 경계도 둔다. 섹터는 6개/weight 합 10000, 티켓 비용은 현행 1, YALLA는 글자 1/2/2, 임의의 봇 종류/새 방어 방식은 허용하지 않는다. Crown required는 기존 3슬롯 이하, Star/Camel은 5슬롯 이하, YALLA 보관량은 기존 5/10/10 이하, Shield cap은 3 이하만 허용한다. 큰 구조 변경은 config 숫자만 바꿔 기존 UI와 불일치시키지 않는다. 티켓 cap을 낮춰도 기존 보유분을 회수하지 않는다.

## Journey 마일스톤 이전과 중복 방지

기존 `PROGRESS.distance`, `lastDistanceMilestone`은 유지하고 새 `JOURNEY#CHESTS`를 추가했다.

```ts
{ schemaVersion:1, version, updatedAt,
  processedDistance:"330", claimedChestCount:"1",
  configVersion:"journey-v1", configHash:"..." }
```

미존재 시 기존 현재 거리와 기존 milestone을 baseline으로 사용하며 과거 구간을 소급 지급하지 않는다. 새 상자는 `floor(after / currentStep) - floor(max(before, processedDistance) / currentStep)`로 판정한다. 거리 간격을 바꿔도 version별 milestone 0부터 다시 시작하지 않는다. `ONCE`는 이미 지급한 누적 상자 수가 있으면 재지급하지 않는다.

거리/Wallet/Collection/Round/Session/마일스톤/경제 영수증은 같은 트랜잭션에 저장한다. Round에는 `journeyAward={count,firstMilestone,distancePerChest,rewardType,rewardAmount,total}`를 남긴다. 기존 ordinal은 호환용으로 보존하되 변경된 거리 간격의 중복 방지 기준으로 다시 사용하지 않는다. Unity 상자 연출에는 해당 Round의 고정 거리 간격을 전달한다.

## 신규 API 계약

모두 기존 Bundle 1 access JWT/Player 소유권 검사, `cache-control:no-store`를 사용한다. 클라이언트가 보상 금액/성공 결과/Wallet 잔액을 지정할 수 없다.

| API | 요청 |
|---|---|
| `GET /bonuses` | 없음. 권리/미완료 게임/Wallet/설정 및 journal 복구에 사용 |
| `POST /bonuses/ensure` | `{kind:"Jackpot"|"Raid"}`. FIFO 배치를 활성화 |
| `POST /bonuses/announce` | `{roundId:string}`. 기존 Collection 안내 확인 |
| `POST /bonuses/finish` | `{kind:"Jackpot"|"Raid"}`. 전부 확인한 배치 종료 |
| `POST /bonuses/jackpot/spins` | `{requestId:UUID}` |
| `POST /bonuses/jackpot/{operationId}/ack` | `{}`. 지급 후 연출 확인 |
| `POST /bonuses/raids` | `{requestId:UUID,botId?:string}`. 선택 준비, 비용 없음 |
| `POST /bonuses/raids/{operationId}/attack` | `{requestId:UUID,facilityId:0..4}` |
| `POST /bonuses/raids/{operationId}/ack` | `{}`. 성공 GET 또는 실패 연출 확인 |
| `POST /bonuses/raids/{operationId}/cancel` | `{}`. READY에서만 무료 취소 |

성공은 HTTP 200, 기존 Drop snapshot에 다음을 추가한다.

```ts
{
  session, round, save:{profile,progress,wallet}, collection, serverTime,
  bonus:{schemaVersion,version,updatedAt,
    run:CollectionBonusRun|null, queue:CollectionBonusRun[],
    jackpot:JackpotSpinReceipt|null,
    raid:{bots:RaidBotProfile[],activities:RaidActivityRecord[],activeRaid:RaidOperation|null}},
  settings:{collection:ConfigEnvelope,journey:ConfigEnvelope,jackpot:ConfigEnvelope,raid:ConfigEnvelope},
  result?: JackpotRecord | RaidRecord // spin/begin/attack 응답
}
```

`CollectionBonusRun`은 기존 Unity Kind/Total/Completed/TotalReward/RoundId/Cause/Announced와 대응하는 camelCase 필드다. 서버 내부 `batchKey`는 권리 원인을 참조한다. JackpotRecord는 `id,segment,weight,goldReward,ticketsBefore,goldBefore,acknowledged,paidToYallaPoint,config,batchKey,sequence` 및 metadata. RaidRecord는 `operation,status=READY|SETTLED|CANCELLED,acknowledged,batchKey,sequence,result?` 및 metadata. operation의 config/eligibleCosts는 준비 시 고정하며 result는 기존 RaidActivityRecord의 camelCase 형태다.

오류: 기존 `{error:CODE}`. 400 입력/대상 오류, 401 인증 오류, 404 소유하지 않은 항목, 409 권리 부족/배치 순서/미완료/변경 시설 재제출/취소된 게임/동시 상태 변경 등. 설정 오류는 위 503 코드를 사용한다. 서버 오류를 로컬 지급으로 대체하지 않는다.

## DynamoDB 원자성 / 복구

기존 `PLAYER#<id>` key 공간과 Wallet/Collection/Economy receipt를 재사용한다.

- 기존 `BONUS#<roundId>#jackpotTickets|raidTickets`: 발급 권리. `PENDING → ASSIGNED → DONE`, 원래 total을 보존.
- `BONUS#STATE`: 현재 배치/queue/Jackpot 표시 receipt/봇 상태/최근 Raid activity 40개. 큐가 빌 때 pending 권리를 최대 20배치씩 불러오며 나머지 권리는 DB에 남긴다.
- `JACKPOT#<requestId>`: 불변 지급 결과 및 acknowledgement checkpoint.
- `RAID#<requestId>`: READY → SETTLED 또는 CANCELLED. 결과는 확정 후 보존한다.
- `ECONOMY#OP#jackpot:<id>` / `raid:<id>`, `ECONOMY#CAUSE#bonus:<batchKey>:<sequence>`: 원인별 영수증. 실제 configVersion/configHash/잔액 전후/지급 결과를 저장.

Jackpot은 권리 감소+Wallet 지급+결과+배치 상태+영수증+원인 marker를 하나의 조건부 트랜잭션으로 저장한다. 미확인 결과가 있으면 새 requestId여도 새로 뽑지 않는다. ack는 완료 수만 한 번 증가시키며 돈을 지급하지 않는다.

Raid 준비/변경은 무과금. 시설 선택 시 티켓 감소+봇 Shield/버전+Wallet+결과/활동+배치 상태+원장을 원자적으로 저장한다. 같은 Raid/시설 재제출은 지급 없이 응답하고 다른 시설로 바꾸면 409. 확정 Raid는 취소할 수 없다. ack가 끝나기 전 새 Raid는 시작하지 않는다.

Wallet/Collection/Bonus/Session version 조건을 함께 사용한다. 기존 Drop이 pending이면 보너스 경제 command를 막고, 활성 보너스 배치가 있으면 새 Drop을 `BONUS_ACTIVE`로 막는다. 단순 대상 선택이나 네트워크 재시도로 티켓이 중복 소비되지 않는다.

## Unity 변경 및 기존 코드 유지

기존 씬/프리팹/캐릭터/휠 각도/공격·방패·GET·먼지/커튼 애니메이션은 그대로 사용한다. scene/prefab 파일은 이번에 변경하지 않았다.

- 새 `Core/Data/ServerBonusClient.cs`: 비동기 API, 서버 snapshot 투영, 별도 `yalla-server-bonus-v1-<playerId>.json` journal. 기존 로컬 Save/Keychain과 분리한다. 요청 ID와 선택 입력을 첫 요청 전에 원자 저장하며 재실행 GET에서 미완료 command를 같은 ID로 재전송/복구한다. 이미 관측한 결과를 다시 뽑지 않는다.
- `YallaJourneyPlayerStore.Server.cs`: 기존 Run/Queue/Jackpot/Raid DTO로 읽기 전용 화면 투영. 서버 Wallet 값은 기존 로컬 Save의 경제 필드를 덮어쓰지 않는다.
- `YallaJourneyPlayerStore.cs`, `.Raid.cs`, `.CollectionBonus.cs`: 로컬 지급·소비 command는 온라인에서 명시적으로 거부. 조회는 서버 상태를 읽는다. 기존 메서드는 offline 도구를 위해 유지한다.
- `JackpotSceneTransition`, `RaidSceneTransition`: 서버 배치/게임 준비를 기다린 뒤 기존 additive scene 진입.
- `JackpotWheelPopup`: 서버 sector/reward로 기존 휠을 회전. 서버 보상 label을 런타임 ScriptableObject 복사본에 적용하며 asset 파일은 쓰지 않는다.
- `RaidSceneView`: 공격/대상 변경의 비동기 응답을 기다리고 기존 Success/Blocked/Scout/Reward 연출을 실행.
- `RewardClaimController`: optional async acknowledgement 추가. GET 뒤 서버 확인까지 기다린다. 기존 동기 호출도 유지.
- `CollectionCompletionFeedback`: Bundle 2의 온라인 보너스 차단을 서버 경로로 교체. 기존 안내·AUTO pause·batch 순서 재사용.
- `CollectionEmblemOverlay`: Config 보상 label/지원 슬롯 수 반영. 레이아웃 재설계 없음.
- `FiftyFiftyBettingController.Server.cs`, `.cs`, `ServerDropContracts.cs`: Drop 직후 서버 권리 갱신, Collection 표시 이벤트, 공유 Wallet 갱신. 기존 로컬 정산 경로는 재활성화하지 않음.
- `CamelJourneyMovement.cs`, `CamelJourneyGameplayPresentation.cs`: 해당 Round의 상자 간격으로 기존 카운트다운/상자 연출 유지.
- `link.xml`: 새 journal과 기존 Raid/Jackpot DTO IL2CPP 보존.

Backend 주요 변경 파일: `src/game-config.ts`, `src/bonus.ts`, `src/drop.ts`, `src/drop-economy.ts`, `src/handler.ts`, `config/dev/*.json`, `infra/generate.py`, `infra/bundle1.json`, `tests/bonus.test.ts`, `tests/drop.test.ts`, `scripts/publish_game_config.py`, `scripts/smoke_bundle21.py`, 본 문서/README. Unity 경로는 모두 `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/` 기준이며 위 class명과 동일한 기존 경로에 있다. 빠른 C# 검사 도구 `Tools/Validation/BackendBundle2/compile.py`에는 새 source만 추가했다.

## 검증 결과

- TypeScript typecheck/build 통과.
- 기존 인증/Player/Drop 회귀 + 신규 Config/보너스 검사 **65/65 통과**, 배포 전 실행 214ms.
- Jackpot roll 0..9999 전체를 열거해 정확히 3500/2500/1800/1200/800/200회 분포 검증.
- Config TTL/동시 로딩/invalid update/환경 분리, Camel Shield·overflow, Journey 간격 변경/단회 보상/워터마크, Jackpot 원자성/응답 유실, Raid 고정 config·6봇·Shield 차감·무료 취소·중복 지급 방지 단위 검사.
- 권리 부족/다른 소유자/미완료 종료 검사를 보강한 신규 테스트 12개도 220ms에 통과.
- Unity를 실행하지 않는 C# source compile 통과. 첫 검사에서 JValue/JObject 조건식 cast 2건을 수정하고 통과했다. IL2CPP/native/iPhone 빌드 성공으로 해석하지 않는다.
- 실제 AWS dev API·DynamoDB 검사 **49개 통과**. 새로운 검증 Guest 한 명만 생성했다. 권리를 DynamoDB에 임의 주입하지 않고 실제 Drop API의 Collection 정산으로 얻었다.

검증 Player `596f72fc-8409-4c74-8ede-de5993504151`.

- Session `a661be6c-5124-49ac-98f7-710e81755ca2`.
- Jackpot `34e5bd30-a49d-4f57-a433-5ec057bd1e13`, 실제 뽑힌 보상 **250 YallaPoint**.
- Raid `5c7f56ea-45d7-48f7-8eed-f45894af93f6`, 보상 **100 YallaPoint**.
- 5개 Drop + 보너스 후 최종 DB Wallet **Energy 55 / YallaPoint 650 / Diamond 0**, 거리 **330m**.
- Journey 상자 1개/Energy 20, watermark `processedDistance=330`, `claimedChestCount=1`.
- Jackpot/Raid 영수증의 실제 configVersion, 완료 상태, 동시 중복 요청, 새 requestId 재제출, 변경 시설 거부, 유실/재접속 조회, GET 중복 확인.

API의 Drop actual은 테스트용 DTO였다. Unity 물리 및 화면 E2E는 실행하지 않았다. 실제 봇 초기 Shield는 0이므로 BlockedByShield 분기는 fake config를 사용하는 빠른 단위 검사로 검증했으며 이를 위해 실제 S3 확률/방패 설정을 바꾸지 않았다. Config TTL 실제 60초 대기는 하지 않고 fake clock으로 검증했다.

## 남은 제한과 iPhone 인수 검사

1. 기존 Bundle ID/Keychain namespace를 유지해 사용자가 Development Build를 내보내 설치한다. 이번 작업에서 앱/Save를 삭제하지 않았다.
2. `[Backend Bundle2] ready`와 기존 Guest Player ID/서버 잔액을 확인한다. 실제 Drop 25개 → 자연 결과 제출 → Wallet/거리/Collection 변화를 확인한다.
3. Crown 완성 후 기존 Collection 안내 → Jackpot scene/커튼 → SPIN → 서버 지정 sector/표시 금액 → GET → 다음 배치/메인 복귀를 확인한다. SPIN 연타와 GET 연타에도 티켓/금액이 한 번만 바뀌어야 한다.
4. YALLA 완성 후 Raid Scout/6대상 선택/대상 변경/시설 선택/공격/Reward GET/먼지 복귀를 확인한다. 현행 기본값에서 성공 보상은 100이다. 봇은 자신의 World/Village와 동일하고 시설 초기 stage는 모두 0(내부 level 1)이다.
5. SPIN 직후, Raid 선택 전, 공격 제출 직후, GET 직전에 각각 네트워크 차단/강제 종료 후 복구한다. 같은 결과/active operation을 복구하고 재소비·재지급하지 않아야 한다. 서버 오류는 기존 재시도 표시를 사용하며 로컬 정산으로 우회하지 않는다.
6. 실제 누적 거리 300m 상자 crossing에서 Energy 20을 확인하고 앱 재실행 뒤 같은 상자가 재지급되지 않는지 확인한다. 서버 로그/DynamoDB Wallet·Collection·JOURNEY#CHESTS·경제 영수증과 기기 UI를 비교한다.
7. 왕복 후 AUTO/Wallet 공개/Collection badge/기존 Drop 재시작을 확인한다. API requestId, Player/operation ID는 진단에 사용할 수 있지만 JWT/Guest 키는 로그에 남기지 않는다.

남은 범위: iPhone 실제 UI/물리/IL2CPP 검증은 사용자 수행 대상이다. Village 전체 서버 migration이나 실제 PvP/incoming Raid는 추가하지 않았다. 기존 로컬 Save의 잔액/옛 티켓을 서버로 합산/import하지 않는다. Drop PERMISSIVE는 기존대로 dev 전용이다. 구조를 바꾸는 config(새 섹터 수/새 글자 조합/새 봇/큰 슬롯 수)는 서버 스키마에서 거부한다.

## Unity 변경 파일 전체 경로

- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Backend/ServerDropContracts.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Backend/link.xml`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/CamelJourneyMovement.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/JackpotWheelConfiguration.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.CollectionBonus.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.Raid.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.Server.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Collection/UI/CollectionCompletionFeedback.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Collection/UI/CollectionEmblemOverlay.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Jackpot/UI/JackpotSceneTransition.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Jackpot/UI/JackpotWheelPopup.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Journey/UI/CamelJourneyGameplayPresentation.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Raid/UI/RaidSceneTransition.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Raid/UI/RaidSceneView.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Reward/UI/RewardClaimController.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftyBettingController.Server.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftyBettingController.cs`
- `/Users/lewis/Developer/YallaJourney/Tools/Validation/BackendBundle2/compile.py`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/ServerBonusClient.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/ServerBonusClient.cs.meta`
