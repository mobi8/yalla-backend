# Backend Bundle 2 — 구현·검증 및 iPhone 인수 검사

2026-11-17, Asia/Dubai. Backend `/Users/lewis/Developer/yalla-backend`, Unity `/Users/lewis/Developer/YallaJourney`.

서버 Session/라운드별 Set 배정, Energy 차감·자연 충전, 실제 결과 검증, YallaPoint/Journey/Collection 연쇄 정산, Wallet 표시 및 재접속 경로를 구현했다. AWS dev에 배포하고 실제 API/DynamoDB 검증을 완료했다. **Unity/iPhone 물리 실행은 하지 않았다. 최종 기기 성공 판정은 아래 수동 검사를 통과한 뒤 내린다.**

## 배포 및 보호 범위

- Profile `yalla-dev`, Region `ap-south-1`, 기존 Stack `yalla-dev-bundle1` 업데이트 성공.
- API: https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com
- 기존 테이블 `yalla-dev-bundle1-PlayerTable-1TPG03GJPKOHQ`, Cognito Pool/Client/인증 연결 유지.
- 기존 Player 초기화, 잔액 migration/import, 리소스 재구축, 파일 삭제, Git reset/checkout/commit을 하지 않았다.
- S3 파일에는 쓰지 않았다. Lambda Player 역할에 해당 prefix의 ListBucket/GetObject만 추가했다.
- Unity GUI, Unity Test Runner, Unity batch process, iPhone 설치/실행을 하지 않았다.
- 기존 미커밋 수정은 보존했다. 기존 수정 파일인 `FiftyFiftyFixedFreshRound.cs`에는 Seed/온라인 timeout 경계만 추가 수정했다.

## 변경 파일

Backend 경로는 `/Users/lewis/Developer/yalla-backend/` 기준.

| 파일 | 구현 |
|---|---|
| `src/pools.ts` | S3 다중 파일 검색, JSON 검증, TTL 캐시, 암호학적 난수 Set 선택 |
| `src/drop.ts` | Session/Round, 조건부 트랜잭션, 발급·정산·환불·재조회·원장 |
| `src/drop-economy.ts` | 12분 충전, 정수/정확한 decimal 계산, 기존 Collection 규칙 |
| `src/handler.ts` | 기존 인증을 사용하는 Drop API 라우팅 |
| `infra/generate.py`, `infra/bundle1.json` | 기존 dev 스택의 경로·환경 변수·S3 읽기 권한 |
| `package.json`, `package-lock.json` | 공식 AWS S3 SDK |
| `tests/drop.test.ts` | 빠른 경제/중복/동시성/캐시/복구 검사 14개 |
| `scripts/smoke_bundle2.py` | 새 검증 Guest만 사용하는 실제 API/DynamoDB 검사 34개 |
| `README.md`, `docs/09-bundle2-implementation.md` | 구현 및 기기 인수 검사 |

Unity 경로는 `/Users/lewis/Developer/YallaJourney/` 기준. 신규 C# 파일에는 `.meta`도 추가했다.

| 파일 | 변경 메서드/역할 |
|---|---|
| `Assets/YallaDrop/Core/Backend/ServerDropContracts.cs` | 서버 Session/Round/결과/보상/Collection DTO, `ServerDropSnapshot.Read`, `ServerDropState.Accept` |
| `Assets/YallaDrop/Core/Backend/GuestBackendClient.cs` | `SendAuthenticatedAsync`: 기존 Keychain/refresh/소유권 검사 재사용 |
| `Assets/YallaDrop/Core/Backend/BackendGuestObserver.cs` | 공유 `Client`, version/소유권을 검사하는 `AcceptServerSave` |
| `Assets/YallaDrop/Core/Backend/link.xml` | DTO 및 journal IL2CPP 보존 |
| `Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftyBettingController.Server.cs` | 온라인 라운드 발급·실제 결과 제출·재진입·timeout·Wallet 표시·journal |
| `Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftyBettingController.cs` | `Session`, `StartRound`, `TryBeginGameplayRound`, `ReservePredictionDrop`, `ResolveResult`, `CompletePresentedRound`, `Update`, pause/quit 경계; 기존 연출을 `PresentConfirmedResult`로 공유 |
| `Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftySessionResultSupply.cs` | `FromServer`, `Seed`: 로컬 랜덤 선택 대신 발급된 한 Set 주입 |
| `Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftyFixedFreshRound.cs` | `BeginSessionRound` 서버 Seed 사용, `BeginRound` Seed 덮어쓰기 제거, `WatchSessionRound` 온라인 timeout 분기 |
| `Assets/YallaDrop/Gameplay/Drop/Physics/FiftyFiftyResultGate.cs` | `PresentNaturalResult` → `ResolveNaturalResult(ball)`; Ball ID도 전달 |
| `Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.Server.cs` | 서버 상태의 읽기 전용 화면 투영, 보호 필드 비교, 기존 로컬 경제 값 보존, `PublishServerDisplay` |
| `Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.cs` | `Load`/`Save` 온라인 모드의 로컬 자연 충전·경제 쓰기 차단 |
| `Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftyCollection.cs` | `ConfirmRound` 온라인 중복 정산 차단 |
| `Assets/YallaDrop/Features/Collection/UI/CollectionCompletionFeedback.cs` | 서버 권리를 로컬 보너스 실행으로 소비하지 못하게 차단; 미소비 권리 때문에 Drop 루프가 정지하지 않도록 분기 |
| `Tools/Validation/BackendBundle2/compile.py` | Unity 프로세스 없이 기존 참조로 C# 소스 검사. 자동 반복 실행하지 않음 |

## Result Pool

`RESULT_POOL_BUCKET=yalla-result-pools-533266967583`, `RESULT_POOL_PREFIX=result-pools/v1/`.

- `result_pool_100_<양의 정수>.json` 파일들을 S3 pagination으로 검색한다. 각 파일은 100행이어야 한다.
- 필드: `setId` 양의 정수/파일 내 유일, `order`는 0..24의 순열, `ball`은 Ball001..Ball025, `color` RED/GOLD/BLUE, `symbol` Y/A/L/Star/Crown/Camel.
- 파일 내 같은 Ball의 Color/Symbol 충돌도 거부한다. 파싱/다운로드/검증 실패 파일은 제외하고 안전한 key만 로그에 남긴다.
- 사용 가능한 Set 전체에서 균등 선택한다. 고유 식별은 `setKey=<S3 key>:<setId>`, 내용 버전은 파일 SHA-256.
- Lambda 실행 환경별 캐시 TTL 60초. 동시 갱신은 하나의 Promise로 합친다. 추가/수정/삭제는 해당 캐시의 다음 갱신부터 적용된다. 매 라운드 목록 조회를 하지 않는다.
- 목록 조회 자체가 실패하면 갱신 요청은 실패하고, 유효 Set이 없으면 503. 삭제된 파일을 무기한 이전 캐시로 계속 제공하지 않는다.
- Round 발급 시 파일 ID/hash/Set ID/order/seed/예상 triple/physicsVersion을 전부 복사한다. 이후 S3 변경은 발급된 Round에 영향을 주지 않는다.
- 설정 Seed `12345`, `PHYSICS_VERSION=fixed-fresh-round-v1`. Seed를 바꾸려면 그 Seed로 검증된 pool/config를 함께 운영해야 한다.

실제 첫 S3 파일은 JSON 배열 100행, 35,025 bytes, SHA-256 `5b85a3448f730e7c8ee808c6b4f2009179a49cca1e6979469f6270bb9ae2cbd3`이었다. 기존 Unity Resources의 500세트 파일을 온라인 선택에 사용하지 않는다.

## API 계약

모든 경로는 Bundle 1 access JWT와 동일한 인증/Player 소유권 검사를 사용한다. Player ID, 보상 금액, 최종 잔액은 입력받지 않는다.

| 메서드/경로 | 요청 | 응답 |
|---|---|---|
| `POST /drop/sessions` | `{}` | 하나의 활성 Session 생성 또는 기존 Session 복구 |
| `GET /drop/sessions/active` | 없음 | 충전 반영, 활성 Session 및 pending Round/최신 Save |
| `POST /drop/sessions/{sessionId}/rounds` | `{requestId: UUID, prediction: "RED"|"GOLD"|"BLUE", energyCost: 1|2|3}` | 발급된 Round와 차감 후 Wallet |
| `GET /drop/sessions/{sessionId}/rounds/{roundId}` | 없음 | 해당 Round 및 현재 상태/잔액 |
| `POST /drop/sessions/{sessionId}/rounds/{roundId}/result` | `{requestId: UUID, actual: {ball, color, symbol}, physicsVersion: string}` | 확정 Round, 보상, 정산 후 Wallet/Progress/Collection |
| `POST /drop/sessions/{sessionId}/rounds/{roundId}/cancel` | `{requestId: UUID, reason: "PHYSICS_TIMEOUT"}` | 조건부 환불 및 CANCELLED Round |

공통 성공 응답(HTTP 200):

```ts
{
  session: {
    sessionId, mode: "ENERGY_DROP", status: "ACTIVE", schemaVersion, version, updatedAt,
    nextRound, completedRounds, pendingRoundId,
    recentConfirmedResults?: Array<{round, color, symbol}> // 최근 40개, 표시용
  } | null,
  round: {
    roundId, sessionId, roundNumber, status: "ISSUED" | "SETTLED" | "CANCELLED",
    schemaVersion, version, updatedAt, issuedAt, cancelAfter,
    poolFileId, poolVersion, setKey, setId, seed, physicsVersion,
    order: number[25], expected: {ball, color, symbol},
    prediction, energyCost, multiplier, policy: "PERMISSIVE",
    actual?, actualPhysicsVersion?, matchStatus?: "MATCH" | "MISMATCH", settledAt?,
    reward?: { yallaPoint, distance: string, distanceEnergy, collectionEnergy,
      jackpotTickets, raidTickets, shields, overflowShields, multiplier }
  } | null,
  save: { profile, progress, wallet }, // Bundle 1 스키마 유지
  collection: { schemaVersion, version, updatedAt, crownProgress,
    yallaYCount, yallaACount, yallaLCount, starProgress, camelProgress,
    jackpotTickets, raidTickets, shieldCount } | null,
  serverTime: string // ISO UTC
}
```

`Round.multiplier`는 발급 당시 예상 결과 배수다. PERMISSIVE 불일치 정산의 실제 배수는 `Round.reward.multiplier`에 확정한다. `actual`은 승자 물리 객체를 폐기하기 전에 별도 DTO로 복사한다.

오류는 기존 `{error: CODE}` 형식: 400 INVALID_REQUEST/INVALID_JSON, 401 인증 실패, 404 소유하지 않은 Session/Round, 409 ROUND_PENDING/INSUFFICIENT_ENERGY/IDEMPOTENCY_CONFLICT/RESULT_CONFLICT/ROUND_CANCELLED/CANCEL_TOO_EARLY 등, 503 pool/config/재시도 오류. `PERMISSIVE` 시작·정산은 `ENVIRONMENT=dev`와 설정을 모두 만족해야 한다.

## DynamoDB 원자성 및 경제

기존 PK `PLAYER#<playerId>`에서 다음 SK를 추가한다.

- `SESSION#ACTIVE`: 활성 Session ID. 조건부 생성으로 플레이어당 하나.
- `SESSION#<sessionId>`: 다음 번호, 완료 수, pending Round, 표시용 최근 결과. Wallet 잔액을 별도 복제하지 않는다.
- `ROUND#<roundId>`: 발급 입력 전체와 예상/실제 결과, 상태, 보상. 한 pending만 허용한다.
- `COLLECTION`: 기존 전역 Emblem 규칙의 카운터/티켓/Shield.
- `DROP#REQUEST#<requestId>`: 시작 입력 hash와 발급 Round. 입력이 다르면 409.
- `ECONOMY#OP#start:<roundId>`, `settle:<roundId>`, `cancel:<roundId>` 및 각 `ECONOMY#CAUSE#...`: 불변 영수증/중복 방지. 충전 지급도 영수증 저장.
- `BONUS#<roundId>#jackpotTickets|raidTickets`: 지급 원인이 연결된 미소비 보너스 권리.

발급은 Wallet·Session·Round·요청 marker·원장을 한 트랜잭션에 저장한다. 정산은 Wallet·Progress·Collection·Round·Session·권리·원장을 한 트랜잭션에 저장한다. 기존 항목은 version 조건, 신규 기록은 부재 조건을 사용한다. 동시 조회도 Session version을 다시 검사하여 확정된 잔액과 과거 pending 상태가 섞이지 않도록 한다.

동일 시작 요청은 같은 Round를 반환한다. 정산된 Round의 동일 actual/version 재제출은 새로운 requestId여도 추가 지급 없이 응답한다. 변경된 actual은 409. CANCELLED는 정산 불가. 취소는 발급 후 서버 시간 120초 이상, 해당 pending/ISSUED일 때만 원래 비용을 한 번 환불한다. 임의 지급량/Set 교체 API는 없다.

경제 정책:

- 자연 충전 720초당 1, 상한 50, 서버 UTC/high-water 사용. 보상 초과 보유 허용, 50 이상이면 anchor=0. 이후 50 미만으로 소비할 때 새 타이머 시작.
- 실제 Unity `MaxEnergyMultiplier=3`, `NextEnergyMultiplier`도 1→2→3→1이었다. x1~x5 레거시 선택을 새로 확장하지 않았다.
- YallaPoint `10 × (적중 RED/BLUE 2, GOLD 8, 실패 1) × Energy`.
- 거리 `10 × (Y/A/L .5, Star 1, Crown 2, Camel 3) × 예측 배수 × Energy`.
- 거리는 BigInt 고정 소수점 계산 후 Bundle 1 decimal 문자열/DynamoDB 정확한 숫자 형식 유지.
- 300m milestone마다 Energy 20, 누락 구간 여러 개도 한 번에 지급하고 checkpoint 저장.
- Crown 3개→Jackpot 티켓 1, Star 5개→Energy 5, Camel 5개→Shield(상한 3), 초과 Shield당 Energy 3.
- Y/A/L 보관 상한 5/10/10, Y1+A2+L2→Raid 티켓 1. 초과 문자 Energy 환불 없음. 수량은 committed Energy이며 예측 배수를 곱하지 않는다.
- C# int 한계 검증/decimal 한계를 보전하며 overflow면 트랜잭션 전에 실패한다.

## Unity 전환·복구

온라인 게임에서는 서버 준비 전 Drop을 막는다. 기존 물리 파라미터/25개 공/승자 Gate/결과 연출을 보존한다. 고정 Seed 덮어쓰기만 제거하고 서버의 frozen Set을 기존 fresh physics world에 넣는다.

`yalla-server-drop-v1-<playerId>.json` journal은 기존 `yalla-journey-player.json`과 별개다. 임시 파일+replace/backup으로 요청 ID/발급 ID/복사한 실제 결과를 저장한다. 비밀 자격은 저장하지 않는다. 시작 전 intent를 기록하고 응답 유실 시 같은 요청을 재사용한다. 자연 승자 결과를 제출 전에 저장하며, 재실행 때 이미 관측한 결과는 물리 재실행 없이 제출한다. 서버 확정 뒤 journal을 비운다. 다른 기기가 먼저 확정/취소한 경우 서버의 terminal 상태를 받아 충돌 루프를 끝낸다.

물리 timeout에서는 같은 예약/Set/Seed로 재시도한다. 클라이언트가 다른 Set으로 바꾸거나 로컬 환불하지 않는다. 서버의 120초 취소 조건을 충족해야 환불된다. world cleanup 실패 시 새 world를 겹쳐 생성하지 않고 pending을 유지한다.

서버 상태는 메모리의 화면 모델로 투영하고 기존 `PlayerSaved` 표시 이벤트로 WalletHUD/Emblem/Shield UI를 갱신한다. 기존 파일의 경제 필드에 서버 잔액을 써넣지 않는다. 로컬 잔액 합산·초기화·서버 import도 하지 않는다. 온라인 Load/Save의 로컬 자연 충전은 실행하지 않는다. 변경된 경제·진행 필드를 로컬에 저장하려는 경로는 거부하고 기존 파일 값을 보전한다.

**범위 경계:** Jackpot/Raid 보너스 권리는 서버에 저장하지만 소비·보너스 게임 정산 API는 이번에 새로 만들지 않았다. 로컬 보너스 소비는 차단된다. Village 건설/상자, 구매, 기존 로컬 Raid/Jackpot 등 미이전 경제 쓰기도 서버 Wallet과 병행하지 못한다. 해당 기능의 서버 command가 필요하면 후속으로 기존 규칙을 이전해야 한다. UI 레이아웃은 변경하지 않았다.

## 완료한 빠른 검증

- TypeScript typecheck/build 통과.
- 기존 인증/Player 39개 + 최종 Drop 14개, **53/53 통과**(245ms).
- 응답 유실 후 commit 복구, overflow 무변경, 조회 중 동시 정산의 Wallet/상태 일관성도 검사했다. 오래 걸리는 전체 검사는 실행하지 않았다.
- Unity 프로세스 없이 기존 프로젝트 참조를 사용한 C# iOS development 소스 검사 통과. 첫 검사에서 누락된 `System` qualifier 한 건을 수정 후 통과했다. Unity Test Runner나 네이티브 빌드 성공을 의미하지 않는다.
- 첫 dev 검증 22개, 최종 dev 검증 **34개** 통과. 검증용 Guest 두 명만 생성했고 기존 Player는 조회/수정하지 않았다.

최종 검증 Player `d35df071-33b9-4bee-a4ce-4f6d05997168`, Session `1ab76988-f7c7-4499-8d8a-2c1d972d5614`.

4라운드와 중복 결과 제출 후 DynamoDB 확인:

- Wallet Energy **58**, YallaPoint **240**, Diamond **0**.
- 거리 milestone **1**, 300m 상자 Energy 20 한 번 지급, 50 초과 잔액 유지/자연 충전 없음.
- Collection Jackpot 권리 누적, 최근 결과 4개 복구.
- 실제 결과 및 MISMATCH, 영수증·원인 marker 저장 확인.
- 동시 시작/동시 정산/새 요청 ID 재제출/변경 결과 거부/재접속/인증 누락/조기 환불 거부 확인.

API 검증의 actual은 **시뮬레이션 DTO**였다. 실제 Unity 물리/화면 E2E 성공으로 계산하지 않는다. 실제 12분 대기나 120초 취소 대기는 하지 않고 빠른 clock 주입 단위 검사로 해당 정책을 검증했다. 새 S3 파일을 업로드하여 실제 bucket을 바꾸는 검사는 하지 않았고 다중 파일 캐시는 fake S3 검사로 검증했다.

## iPhone 수동 인수 검사

1. 기존 Bundle ID/서명/Keychain namespace를 유지하고 Development Build를 내보내 설치한다. 기존 Save/앱을 먼저 삭제하지 않는다. 기존 Bundle 1의 iOS Security.framework/Keychain 브리지를 유지한다.
2. 기기 로그에서 `[Backend Bundle1]` 인증과 `[Backend Bundle2] ready`를 확인한다. 저장된 기기 Guest를 재사용해야 한다. 네트워크가 준비되지 않았으면 DROP이 시작되지 않아야 한다.
3. 현재 서버 Energy/YallaPoint를 기록한다. x1 선택 후 RED/BLUE/GOLD를 한 번 누른다. 서버 응답 이전에 물리가 시작되거나 중복 누름으로 두 Round가 생기면 실패다.
4. 25개 공의 실제 Drop과 자연 승자를 확인한다. `[ROUND_COMPLETE]`의 Set/actual 및 `[Backend Bundle2] SETTLED roundId=... energy=... yallaPoint=...`를 확인한다. 미일치도 dev에서는 actual로 정산되어야 한다.
5. UI 증가량은 YallaPoint `10×실제 예측 배수×Energy`, 거리도 본문의 공식과 일치해야 한다. Energy는 비용만큼 차감하되 발생한 Collection/거리 상자 보상과 서버 자연 충전을 포함해 비교한다.
6. 로그의 Player/Round ID로 DynamoDB WALLET/PROGRESS/COLLECTION/ROUND 및 `ECONOMY#OP#settle:<roundId>`/CAUSE를 확인한다. JWT/Guest 키를 로그에 복사하지 않는다.
7. 결과 확정 후 강제 종료→재실행하여 같은 Player/Session/잔액을 확인한다. 발급 직후 강제 종료는 같은 pending Set을 복구해야 한다. 승자 확정 후 통신 차단→강제 종료→연결 복구에서는 journal actual을 제출하고 이중 지급하지 않아야 한다.
8. 2~3라운드 AUTO도 확인한다. 물리 timeout은 같은 예약 재시도 후 서버 조건부 환불만 허용해야 한다. 수동으로 journal/서버 항목을 고쳐 timeout을 흉내 내지 않는다.

기기 성공 판정: 실제 자연 승자가 서버 Round에 기록되고, Wallet/Progress/영수증이 한 번 갱신되며, 그 잔액이 기기 UI와 재실행 후 동일해야 한다.

## 남은 위험

- iPhone IL2CPP/Xcode 빌드·실제 물리·연출/네트워크 전환 검사는 사용자가 수행해야 한다.
- dev PERMISSIVE는 신뢰할 수 있는 결과 위변조 방어가 아니다. 출시 전 strict 검증/재생·장치 검증 정책이 필요하다. 현재 prod에서는 발급/정산이 거부된다.
- pool JSON 자체에 생성 physics fingerprint가 없다. 현재 config 식별자는 운영용 선언이며 플랫폼 간 물리 일치 증명은 아니다.
- 기존 로컬 Save는 보존되지만 원격으로 이전하지 않았다. 미이전 경제 기능은 위에서 명시한 대로 로컬 실행을 차단한다.
- journal 저장 자체가 실패하면 Drop/정산 진행을 멈추고 pending을 보전한다. 파일이 실제로 유실/손상된 경우 서버 pending은 조회할 수 있지만 이미 관측했던 actual의 복원에는 한계가 있다.
