# 03. 저장 구조·정합성·이전 위험

## 저장 책임과 실패 처리

| 저장소 | 실제 경로/키 | 쓰기와 읽기 | 복구 및 경계 |
|---|---|---|---|
| Journey | persistentDataPath/yalla-journey-player.json | JObject Decimal parse → migration → ToObject; 전체 JSON tmp 쓰기 후 File.Replace(tmp, main, main.bak), 신규 File.Move | 정상 교체 단위는 파일 전체. **Load는 .bak/.tmp를 자동 읽지 않는다**. JSON 손상·IO 오류는 상위로 throw |
| HyperBase | persistentDataPath/save.dat, save.bak | Newtonsoft JSON → EncryptionHelper AES → WriteAllText/WriteAllTextAsync; 먼저 기존 main을 backup에 copy | 주 파일 읽기 실패하면 backup, 둘 다 실패하면 새 PlayerData. atomic replace/동시 save lock 없음; 오류 log만 남김 |
| PlayerPrefs | RateUs_Prompted | int 기본0, 요청 때1, Save; Editor ResetPromptFlag에서 DeleteKey | 게임 잔액/진행 저장 아님 |
| Config/Scene | JackpotWheelConfiguration.asset, AdConfig.asset, Scene ranking snapshot 등 | Unity serialization/Resources.Load; RC FetchAndActivate | 사용자 잔액과 다른 배포 수명. config version과 진행 중 receipt를 보전해야 함 |
| 개발 도구 | CostumeTestOwnership EditorPrefs; 별도 costume original/reset backup | Editor 전용 raw JObject 수정 또는 model Save | 운영 경제 import에서 개발 데이터 식별 필요. 이번 조사에서 실행 안 함 |

근거: [YallaJourneyPlayerStore.cs](../../Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.cs) `Load/Save`, [SaveManager.cs](../../Assets/YallaDrop/Core/HyperBase/Data/SaveManager.cs), [EncryptionHelper.cs](../../Assets/YallaDrop/Core/HyperBase/Data/EncryptionHelper.cs). AES 암호화는 거래 원장·서버 권한을 대신하지 않는다. Journey JSON은 암호화·서명 없는 로컬 데이터다.

`TransactionLock`은 static process 내 모든 Journey store instance가 공유한다. round/shelter/raid/claim도 같은 lock을 사용한다. Save는 disk SaveRevision과 caller revision 일치 조건을 검사하고 성공한 교체 후 caller revision을 갱신한다. 복수 프로세스·서버 간 lock은 아니며 외부 raw 파일 writer는 revision을 올리지 않는다. PlayerSaved observer 예외는 개별 catch하여 이미 성공한 commit을 실패로 보고하지 않는다. UI의 오래된 모델은 reload해야 한다.

## Energy 0 오류 및 JSON null 수정 확인

근거: [PlayerDataLoadCompatibilityTests.cs](../../Assets/YallaDrop/Tests/Editor/PlayerDataLoadCompatibilityTests.cs), [Controller](../../Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftyBettingController.cs) `Session`, [Store.Load](../../Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.cs).

1. 신규 파일 없음: constructor Energy=200을 즉시 저장. 기존 파일에 **Energy property 없음**만 JObject에 50 삽입. 값이 0인 property는 존재하므로 50/200으로 초기화하지 않는다. `ExistingEnergyIsPreservedWithoutStarterGrant`는 고정 clock으로 0/17/200을 검증하도록 작성돼 있다. 실제 시간 경과에 따른 자연 충전은 별개다.
2. Controller는 player.Load 직후 EnergyBalance/HasLoadedPlayerData를 설정한다. 이후 session 초기화 실패를 Energy=0으로 오인하지 않게 한다. 실패 시 session.EndSession으로 game gate를 닫고 로그를 남긴다. 로드 실패를 신규 데이터로 덮지 않는다.
3. `EnergyDropSnapshot`은 `as JObject` 후 접근하므로 JSON null JValue와 누락 모두 pending=0으로 처리한다. `NullOrMissingEnergyDropDoesNotBreakStartup` 회귀 테스트가 존재한다.
4. `SessionSnapshot`도 token 존재와 `JTokenType.Null` 확인 후 호환 검사를 한다.
5. **모든 JSON null을 처리한 것은 아니다.** `Energy:null`, `Diamond:null`, `Profile:null`, 잘못된 scalar/object 모양, `ShelterProgress.ProgressVersion:null` 등은 missing 검사와 다르다. Profile null은 constructor의 GUID fallback으로 ID가 달라질 여지가 있고, primitive null/형식 오류는 역직렬화 예외 가능성이 있다. `ProfilePopupSummary.Refresh`의 `document["Profile"]?["Nickname"]` 등은 명시 null JValue에 대한 `?.` 방어가 아니므로 요약 표시도 깨질 수 있다. 데이터 손상 사례별 fixture 검증이 필요하다.

테스트 소스를 읽어 확인했으며 Unity Test Runner를 실행하지 않았다. 기존 테스트 `LegacyEntryPreservesInitializedEnergyAcrossReloads`는 MinimumBet=50을 기대하지만 현재 Bronze config=100이다. 따라서 테스트 파일 존재만으로 전체 검증 통과를 주장할 수 없다. 코드는 수정하지 않았다.

## 마이그레이션/초기화 행렬

| 조건 | 실제 처리 | 위험/보전 사항 |
|---|---|---|
| 파일 없음 | fresh profile=local:SHA256(absolute SavePath), 기본 재화 즉시 저장 | backup만 남아 있어도 Load는 fresh 생성 가능. Development seed는 bak/tmp도 확인하나 Load는 주파일만 확인 |
| 모델 직접 new | Profile 없으면 local:GUID | Store 신규 경로 hash와 다름. 경로 hash는 인증 자격이 아니며 설치 경로 변경 시 동일 인물 보장 없음 |
| Profile 누락 | 경로 기반 stable profile JObject 삽입 | null과 구분. 서버 UUID 매핑을 별도 유지해야 함 |
| Diamond property 없음 | legacy Gold를 Diamond로 copy, Gold=0; Gold도 없으면20000 | presence marker만 사용. 동명 Gold를 다시 환산하면 이중 지급. 명시 null은 marker 존재로 간주 |
| Energy 없음 | 50 | 저장된0 유지. 다음 transaction/recharge Save가 migration을 기록 |
| PendingEnergy 4..10 | Max=3으로 줄이고 초과 Energy 환불; prediction/index 보전 | 환불+예약 변경 함께 Save. >10/기타 손상은 일반적으로 reject |
| legacy Session invalid tier/확정 round checkpoint 없음 | 해당 SessionSnapshot만 null로 정규화 | 이전 유효 잔액까지 session 내부에 있었다면 유실 경계. 동일 파일 다른 balances/progress 유지; server import에서 미리 판정 필요 |
| Collection Tiers null/retired5..7 | 유효1..4와 non-null entries만 보전 | TierProgress 수치 자체에는 강한 범위/duplicate tier 검증 없음. FindLastIndex claim과 중복 tier 위험 |
| Emblem child null/누락 | 새 EmblemCollectionProgress | 처리했던 보상 receipt가 유실된 파일은 재지급 방지가 약해짐. CollectionVersion은 출력3이며 구버전 branch migration gate 아님 |
| ShelterProgress version 누락 | MyShelterWorlds.MigrateLegacy: world + (village-1)/5, village mod5, 끝 World overflow clamp; Raid 좌표도 변환 | receipt의 원래 village/ID는 유지. BotId 문자열은 재작성하지 않으므로 문자열만 parse해 좌표 판단 금지 |
| ConstructionStars 누락 | ordinal·level로 추론한 knownGrowth와 receipt count 중 max | 현재 World 완료 의미와 과거 linear 이동 의미 차이. 신뢰된 역사 ledger 아님 |
| WorldCompletionCounts 누락 | 이전 World는 각각1 완료로만 추론 | 재방문 횟수 추정하지 않음. HighestUnlockedWorld는 현재 index 기본값; 범위 검사 |
| WorldRunId 누락/공백 | legacy:{WorldId} | 새 run은 GUID. import key에 world/run fence 필요 |
| ChestRewards 누락 | 현재 거리 milestone 및 이미 완료한 World를 **지급 없이** baseline 처리 | 서버에서 재차 과거 chest를 지급하면 안 됨. World baseline receipt.YallaPoints=0 |
| Costume 누락/null | 기본 original_bg, 빈 equipment | unknown/duplicate owned ID 제거; owned가 아닌 equip 제거. catalog를 축소하면 기존 소유권 삭제 가능 |
| pending overflow + config 값 존재 | Load에서 Energy 지급 및 pending 권리 제거 후 Save | 읽기 API도 쓰기. 서버 이전 중 local load를 계속하면 local/server 양쪽 지급 위험 |
| legacy pending Jackpot | RestoreJackpotResult만 known Gold reward를 YallaPoint로 이동 | 자동 bulk Gold 변환 아님. ack된 과거 Jackpot은 이전하지 않음 |

모델 null collection은 대체로 empty/new child로 복원하지만 invalid receipt·음수 balances·unknown world 등은 throw한다. 최상위 `null`/array/손상 JSON은 JObject.Load 단계에서 실패한다. Reset은 Journey 운영 API가 없다. Editor `MyShelterDevelopmentReset.ResetShelterOnly`는 Village/Levels만 바꾸고 receipt·runComplete·stars 등을 유지하여 현재 World invariant와 충돌 가능하다. `CostumeDevelopmentInventory`는 EditorPrefs 기본 true의 test ownership 적용 경로가 있다. Development seed/Jackpot tickets/diamond menu는 운영 baseline과 분리해야 한다.

## 주요 위험 우선순위

| 순위 | 위험과 실제 근거 | 현재 방어 | 서버 전환 시 요구 |
|---|---|---|---|
| 1 | **세션=Wallet 결합**: YallaPointWallet는 mode에 따라 EnergyDropSnapshot 또는 SessionSnapshot 선택. session reset/무효화/legacy mode 전환이 잔액 선택에 영향. 외부 credit는 resumable/pending0 요구 | gameplay gate, pending 체크, 파일 단일 commit | 영속 wallet을 세션과 분리하되 금액/규칙 그대로 이전; 두 snapshot 잔액 중 채택 정책 결정 |
| 2 | **복구 누락/두 저장소 분리**: J bak 생성하지만 Load fallback 없음; H는 fallback 뒤 fresh로 바뀔 수 있음. 설정/레거시 identity와 J identity 별개 | J atomic replace, H backup fallback | import 전 원본 보전·quarantine·승인된 복구 우선순위. 설치 경로 ID를 원격 credential로 사용 금지 |
| 3 | **권한·시간 신뢰**: 로컬 JSON/clock/caller payload가 권한. HighWater는 rollback만 억제하고 시각을 크게 앞으로 조작하는 문제 해결 못 함 | Energy cap, decimal/checked, receipt와 formula 비교 | 서버 clock·인증 player·경제 검증. 결과 자체 신뢰는 이번 범위 밖 결정으로 남김; 무제한 reward 수용 금지 |
| 4 | **중복/부분 정산의 예외 경로**: PurchaseEnergy는 operation ID 없음. legacy H IAP callback에 transaction ID 없음, boost/pack 여러 SaveAsync. standalone GrantJourneyMovement는 마지막 session만 dedupe | J round/raid/jackpot/upgrade/claim은 receipt+동일 파일 방어 | 공통 durable idempotency + payload hash + balance/rights/ledger transaction. H와 J 자동 합산 금지 |
| 5 | **무한 성장 및 stale 재진입**: claim IDs, shelter receipts, Raid bots/activities, ProcessedRounds, bonus queue 누적. Collection 독립 Save의 Load→Save 및 같은-thread 이벤트 재진입 | Revision conflict 검출, TransactionLock, history40개 제한 | append ledger/receipt 분리·보존 정책, item별 version, 응답 유실 조회 계약, UI stale refresh |

추가 확인:

- `CamelJourneyProgress.Grant`는 LastGrantSessionId/LastGrantRound만 저장한다. `GrantJourneyMovement(A)`→`B`→다시`A`를 허용할 세션 변경 조건이 갖춰지면 과거 A dedupe를 기억하지 못한다. 현재 caller 없음이므로 활성 게임 중복 버그라고 단정하지 않으며 서버 adapter에 그대로 노출하지 않는다.
- `SpinJackpot`은 이전 receipt와 동일 request 또는 미확인 receipt이면 기존 결과를 반환한다. payload가 달라진 retry 의미를 별도 정의해야 한다. `ClaimCollectionReward`는 claimId가 이미 있으면 tier payload 비교 없이 false. `GrantUncappedShield`도 재사용 ID의 amount 검증 없음. `UpgradeShelter` receipt에는 WorldId/WorldRunId가 없고 중복 처리 시 world/run 비교 전에 반환한다.
- `ConfirmRaid`는 Begin에 EligibleCosts/ConfigurationVersion을 저장하지만 Confirm에서 공통 비용 함수를 **재조회**한다. Multiplier/TicketCost는 operation snapshot 사용. 배포 중 비용 변경 시 기준 일관성을 결정해야 한다. 현재 모든 cost10이고 bot FacilityLevels는 공격으로 손상되지 않는다.
- J Save 실패 시 파일 revision은 미증가하지만 caller 객체의 사전 mutation은 남을 수 있다. failed transaction을 같은 객체에 단순 재적용하지 말고 Load 후 durable state로 판단해야 한다. SaveManager는 오류를 swallow하므로 호출자가 commit 성공을 알기 어렵다.
- C# monitor lock은 동일 thread에서 재진입 가능하다. PlayerSaved는 commit 이후 lock 안에서 호출된다. observer가 새 transaction을 실행하면 첫 응답 객체는 최신보다 오래될 수 있다. 파일이 손상된다는 단정 대신 버전 응답/재로드 계약 위험으로 기록한다.
- J Load의 migration이 실제로 Save하지 않는 경우도 있다. recharge/overflow/multiplier 변화가 없으면 legacy normalization은 메모리에만 있고 다음 mutation 때 commit된다. 'Load는 항상 읽기 전용' 및 '항상 즉시 migration' 모두 잘못된 가정이다.
- 일반 Save는 unknown JSON field를 ToObject→FromObject 과정에서 유지하지 않는다. 서버 필드를 같은 로컬 파일에 추가해 구클라이언트가 round-trip하면 삭제될 수 있다.

## iOS 재실행·오프라인 복원 경계

현재 iOS는 persistentDataPath에 파일을 남기고 Controller.OnApplicationPause(true)에서 J, 공통 Lifecycle에서 H를 저장한다. resume은 Load로 recharge/pending input을 복원하고, 저장된 PendingEnergy가 있으면 추가 차감 없이 이어간다. Raid/Jackpot은 이미 지급한 미확인 결과를 다시 표시하며 GET는 ack만 한다. OS 강제 종료 시 quit 호출을 전제하지 않는다. 핵심 차감/지급은 애니메이션 전에 저장돼 있어야 하며 현재 J 경로는 이 방향이다.

같은 설치 재실행은 파일 복원에 의존한다. 재설치/다른 기기/컨테이너 이동/백업 복구에서 같은 ID와 최신 저장을 복구하는 클라우드 계정 서비스는 확인 안 됨. 장치에서 atomic replace와 pause/kill 타이밍을 실제 검증하지 않았으므로 iOS 복구 완료라고 보고하지 않는다.

## local/server 충돌 방지의 전환 조건 (설계안)

서버 권한 활성 후 Local Load의 recharge·overflow·legacy Jackpot 이전·starter 생성 결과를 서버 잔액에 매번 합산하면 안 된다. migration batch ID + 원본 hash + source revision + snapshot별 잔액 출처를 한 번만 등록하고, 성공 후 서버 version snapshot으로 client cache를 교체한다. 이후 로컬 Save는 화면 cache만 소유하고 경제 mutation은 server command 응답으로 갱신한다. 서버 응답을 못 받은 retry는 같은 operation ID로 조회/재시도한다. server takeover 이후 오래된 local file을 재import하지 못하게 account migration fence를 유지한다. 오프라인 경제 허용 여부는 06에서 결정한다.
