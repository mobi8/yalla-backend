# 02. 이벤트별 데이터 변경 관계

기호: J=`YallaJourneyPlayerStore`의 전체 player JSON 원자 저장, H=`SaveManager`의 encrypted JSON. 아래 Wallet은 Energy/Diamond/Gold/YallaPoint/ticket/Shield의 경제 상태를 뜻하며, YallaPoint만 의미할 때 명시한다. 모든 J Save는 추가로 Energy recharge를 재계산하고 SaveRevision을 1 증가시킨다. Load도 신규 생성·충전·overflow migration 시 쓰기를 일으킨다. 따라서 '재화 변경 없음'인 조회조차 충전 시 Energy를 저장할 수 있다.

## 현재 활성 경로

`FiftyFiftyBettingController.NoBettingPrototype == true`. EnergyDrop은 Continuous이며 10라운드 종료/Ranking 변환을 수행하는 legacy Session과 다르다. 결과 풀 선택·승패·물리의 서버 이전은 설계하지 않는다. 아래는 기존 결과를 입력으로 받는 **지급·진행·저장 경계**만 다룬다.

| Event | Trigger | Read Data | Modified Data | Save Operation | Related Systems |
|---|---|---|---|---|---|
| 신규 유저 | Store.Load에서 주 JSON 파일 없음 | SavePath, clock | Profile(local hash ID), Diamond=20000, Energy=200, 기본 진행·inventory·receipts, 충전 checkpoint | 즉시 J Save | Profile, Wallet, Progress |
| Development 신규 | BeforeSceneLoad TrySeedFreshPlayer; 주/bak/tmp 모두 없을 때만 | build symbols, 파일 존재 | Diamond=100000, Energy=200, Bronze pending completion=1 | J Save; 일반 신규와 구분 | 테스트 재화/Collection |
| Bootstrap 시작 | BootstrapEntryPoint.RunInitAsync | H 주 파일/backup, RC | H TotalSessionCount++, 첫 실행 GoldBalance=RC starting_gold_balance(100); daily 날짜/streak 조정 | H SaveAsync; 이후 Journey Scene 별도 load | Settings, legacy economy, analytics |
| 게임 시작·재실행 | Controller.Session lazy 초기화 → OpenEnergyDrop | J player, pending reservation, history | snapshot 없으면 continuous snapshot 생성; 존재하면 그대로 복원 | OpenEnergyDrop은 매번 J Save | Wallet, UI, recovery |
| Energy 자연 충전·오프라인 | Load/Save, Controller.Update 약 1초마다 | Energy, Anchor, HighWater, UTC | cap 50 이하에서 10초당 3; 50 이상 유지; high-water rollback 억제 | anchor/잔액 바뀌면 Load에서 J Save; high-water만 바뀌면 다음 Save | Wallet, clock |
| Energy 구매 | PurchaseEnergy(quantity) | Diamond, Energy, pack=20 | Diamond -= quantity/20, Energy += quantity (20의 배수, checked) | 단일 J Save; 요청 receipt 없음 | Diamond↔Energy |
| 색상 선택·DROP 예약 | PlaceBet/BeginEnergyDrop | sessionId, CurrentRound, selected multiplier 1..3, pool index, prediction, Energy | Energy 차감 + PendingEnergy/PoolIndex/Prediction 고정 | 단일 J Save; 동일 예약 재호출 추가 차감 없음 | Wallet, round checkpoint |
| 예약 취소·환불 | CancelEnergyDrop (일치하는 reservation만) | session/round/index/PendingEnergy | Energy 환불 + PendingEnergy=0, PoolIndex=-1 | 단일 J Save; 반복 취소 false | Wallet, recovery |
| 예약 복구의 set 교체 | ReplacePendingEnergyDropSet | 기존 pending index, session/round | index만 교체; input/차감 유지 | J Save | recovery; 풀 내용은 분석 제외 |
| 확정 결과 정산 ★ | Controller 결과 callback → ConfirmEnergyDrop | durable prediction/energy, 확정 color/symbol, Collection projection, distance | ConfirmedYallaPoint 증가, CompletedRounds/CurrentRound/history, pending 제거, legacy CollectionProgress, distance·거리 chest Energy, global emblem·tickets/Shield/Energy, bonus queue, processed round receipt | **전부 단일 J Save** 성공 후 collection event/UI | Wallet + Progress + Inventory + bonus |
| 글로벌 Collection 심볼 | 위 정산 → ConfirmEmblemRound → EmblemCollection.Confirm | symbol, quantity=PendingEnergy, counters, ProcessedRounds, config | 아래 완성 규칙; ProcessedRounds[namespace/session]=round; LastRoundReward | round와 동일 J commit; UI event는 후행 | Collection, Energy, Raid, Jackpot, Shield |
| 거리 chest ★ | SetCamelJourneyProgress | 이전 milestone, 새 decimal distance | distance 증가; floor(distance/300) 증가분마다 Energy +20; LastDistanceMilestone 갱신 | round 또는 GrantJourneyMovement와 동일 J Save | Wallet + 거리 Progress |
| 글로벌 Collection bonus 시작/공지 | EnsureCollectionBonus/AnnounceCollectionBonus | ticket inventory, 미확인 receipts, BonusQueue/Run | unassigned 권리 queue 보전, run 선택/Announced | J Save | 지급이 아닌 연출 순서 checkpoint |
| Shield 초과 권리 복구 ★ | Load에서 pending overflow 존재/가격 non-null; 또는 명시 ResolveDeferredCollectionEnergy | PendingShieldOverflowRewards, PendingCamelEnergyRewards, config | 해당 pending 제거 + Energy 지급; 기존 Shield 자체 환산 안 함 | 단일 J Save | migration, Collection, Wallet |
| 명시 Shield grant | GrantUncappedShield(amount, operationId); 일반 shop caller 없음 | claim ID, ShieldCount | Shield += amount, shield-grant receipt; Collection cap 적용 안 함 | 단일 J Save | inventory/economy; 구매 UI 구현 아님 |
| Jackpot 실행 ★ | SpinJackpot(requestId, SO) | ticket, previous receipt/ack, claim IDs, wallet, SO | ticket -1, YallaPoint += reward, JackpotSpin receipt, jackpot claim ID | **단일 J Save; 연출 전 지급 완료** | Collection entitlement, Wallet, Ledger |
| Jackpot GET | AcknowledgeJackpot | paid receipt, BonusRun | Acknowledged=true, BonusRun.Completed/TotalReward 증가 | J Save; 재지급 없음 | RewardClaimController, bonus queue |
| legacy Jackpot 복구 ★ | GetJackpotResult/SpinJackpot/GET → RestoreJackpotResult | 미확인 PaidToYallaPoint=false receipt, Gold | Gold -= known award, YallaPoint += award, PaidToYallaPoint=true | 단일 J Save; 과거 Gold 전체 환산 아님 | Wallet migration |
| 시설 구매 ★ | MyShelterGrowth → UpgradeShelter | operation ID, expected world/run/village/level/session, cost, resumable wallet, pending=0 | YallaPoint -10, 해당 level +1, ConstructionStars +1, receipt 추가 | 단일 J Save; 동일 op ID 재시도 AlreadyApplied | Wallet + Village/World Progress |
| 시설 MAX 후 World 완료 ★ | MyShelterGrowth.LateUpdate → transition → CompleteShelterWorld | 시설 5개 MAX, world/run fence, pending Raid, WorldReceipts | 첫 해당 World chest만 YallaPoint +100/receipt; 완료 횟수+1, unlock max, WorldRunComplete=true; 미확정 raid target 정리 | 단일 J Save; 같은 완료 재호출 지급 없음 | Wallet + World Progress + Raid |
| World 선택/재방문 | MyShelterSceneTransition → StartShelterWorld | 현재 world/run, complete, unlock, 이전 World completion | Profile.WorldId, level 전부 1/currentVillage 1, 새 WorldRunId, complete=false; 기존 receipt·별·거리·wallet·inventory 유지 | 단일 J Save | World/Progress, Raid target 정리 |
| legacy Village 이동 | AdvanceShelterVillage; 현재 런타임 caller 검색 없음 | completedVillage, complete, expected world/run | CurrentVillage +1, levels reset; target 정리 | J Save | 호환 메서드; 현재 UI World flow와 구분 |
| Costume 미리보기 | CostumePreview.Select | catalog, preview loadout | preview만 변경 | 저장 없음 | Client UI |
| Costume 착용·해제 | CamelCostumeShop → EquipCostume | slot, OwnedIds, catalog, itemId (null=해제) | Equipped.items[slot] 추가/제거 | J Save; 구매/재화 변경 없음 | Inventory + equipment |
| Costume 획득·구매 | 런타임 지급·가격·구매 메서드 없음 | — | 일반 path 없음; 기본 original_bg 및 Editor test ownership만 | 일반 구매 정산 없음 | 미구현; World costume pool 없음 |
| Raid 대상 조회 | GetRaidTargets | world/village, templates/config, 기존 bots | 해당 좌표 6 bots 없으면 추가 | 추가 발생 시 J Save | player별 local bot state |
| Raid 선택 | BeginRaid | tickets 충분성, bot/current world/village/state version, cost rule | ActiveRaid에 op/config/cost/multiplier snapshot | J Save; **이때 ticket 차감 안 함** | target, progress fence |
| Raid 공격 ★ | ConfirmRaid(raidId, facilityId) | 활동 receipt, ActiveRaid, 현재 좌표, bot version/shield, 공통 건설 cost | ticket -TicketCost; shield 있으면 bot shield -1/보상0, 아니면 YallaPoint += eligibleCost×multiplier; bot version +1; activity 추가, ActiveRaid 유지 | **단일 J Save**; 같은 raid ID/시설이면 기존 receipt 반환 | Wallet + bot State + inventory/activity |
| Raid GET | AcknowledgeRaid | committed activity, ActiveRaid, BonusRun | ActiveRaid 제거; BonusRun.Completed/TotalReward 증가 | J Save; 재지급 없음 | Claim UI/bonus |
| Raid 취소 | CancelRaid | ActiveRaid, activity 없음 확인 | ActiveRaid 제거 | J Save; 차감·환불 없음 | target |
| bonus 종료 | FinishCollectionBonus | 완료된 BonusRun | BonusRun=null | J Save | 다음 bonus/게임 복귀 |
| Ranking 조회 | RankingPopupController.Open/Render | Scene snapshot | 표시만 변경 | player 저장 없음 | static sample; attack unbound |
| Friends/Invite/account link | 실제 서비스 path 확인 안 됨 | — | player graph/link fields 없음 | 없음 | Bundle 4 미구현 |
| background/quit/resume | Controller.OnApplicationPause/OnApplicationQuit | 최신 J + clock | recharge/high-water checkpoint, balances refresh | pause에서 J Save; resume Load | iOS pause 저장; 강제 kill callback 보장 아님 |
| 공통 lifecycle | ApplicationLifecycleHandler | H SaveManager | LastSaveTime, session log guard | H Save; J와 별개 | Settings/time/analytics |

★ = 경제 상태와 Progress/권리/영수증을 같이 변경하는 경계. 보상이 없는 UI GET도 지급 영수증과 연출 진행을 함께 갱신한다. 여러 번 Save하는 UI 애니메이션을 재화 지급의 원인으로 사용하면 안 된다.

## Collection 실제 완성 규칙

근거: [EmblemCollectionProgress.cs](../../Assets/YallaDrop/Core/Data/EmblemCollectionProgress.cs) `Confirm`, [CollectionRoundReward.cs](../../Assets/YallaDrop/Core/Data/CollectionRoundReward.cs).

- Crown 3개 → JackpotTickets +1, 나머지 보전. Star 5개 → Energy +5. Camel 5개 → Shield 1, 글로벌 Collection 획득 최대 3. 초과분은 Default config Energy +3/개, 가격 null이면 pending overflow 권리.
- Y/A/L은 Y=1, A=2, L=2가 한 세트 → RaidTickets +1. 각 저장 상한 Y=5, A=10, L=10. 초과 글자는 버리고 Energy 환급 안 함. DuplicateLetterRemainder는 호환 보존만 한다.
- quantity가 여러 개면 몫/나머지로 여러 번 완성 가능. 현재 multiplier는 1..3이나 legacy schema는 10까지 처리 흔적이 있다.
- CamelEnergy=10은 현 Camel 완성 지급이 아니라 **과거 PendingCamelEnergyRewards** 정산에만 사용한다.
- Shield `ConsumeShield`는 모델에 있으나 현재 플레이어가 습격당하는 실행 경로는 확인 안 됨. Raid에서 소비하는 것은 **상대 bot Shield**다. Incoming 활동은 동일 record를 defender 관점으로 조회하는 기능이며 실사용자 PvP 구현 증거가 아니다.

## 레거시 경로: 현재 Journey와 혼합 금지

| Event | Trigger | Read Data | Modified Data | Save Operation | Related Systems |
|---|---|---|---|---|---|
| legacy tier session 시작 | BeginSession(tier) | 기존 ack 상태, EntryTierDefinition | SessionSnapshot 시작 YallaPoint; entry currency 차감 없음 | J Save | 현재 NoBettingPrototype에서 비활성 |
| legacy round 정산 ★ | RecordConfirmedSession | session/round, caller yalla/payout/result | session balance/history, collection, distance + chest Energy, global collection/bonus | 단일 J Save | 신규 결과 설계 대상 아님 |
| legacy 세션 완료 ★ | SettleSession; 10 completed rounds 필요 | ConfirmedYallaPoint, RankingPoints | RankingPoints += 최종 balance, Settled/RankingBefore/After | 단일 J Save; ack 별도 | active continuous에서는 미도달 |
| tier Collection claim ★ | ClaimCollectionReward(tier, claimId) | pending count, EntryTier reward, claim IDs | pending -1, J Gold +=500/1500/3000/6000, claim ID | 단일 J Save | global Emblem과 다른 구 체계 |
| Collection 독립 저장 | FiftyFiftyCollectionStore.Save | 최신 player + caller progress | CollectionProgress 교체 | Load와 Save 사이 전체 lock 없음; revision 충돌 검출 | round callback 통합 저장과 구분 |
| standalone journey grant ★ | GrantJourneyMovement | legacy session, 마지막 거리 receipt | distance 및 chest Energy | 단일 J Save | 현재 외부 caller 없음; 회귀 위험 03 |
| legacy level complete ★ | LevelManager.CompleteCurrentLevel | LevelData GoldReward/boost flags | H GoldBalance, boosts, level/current/highest/total | 여러 H SaveAsync | 게임 진행/보상 분리 저장 위험 |
| daily login/challenge ★ | GoldManager.TryClaimDailyLoginBonus; DailyManager.CompleteChallenge | local date, completion/streak, config | H GoldBalance + flags/streak/milestone boost | 여러 H SaveAsync | 로컬 날짜 사용; J Energy와 무관 |
| legacy boost 구매 ★ | BoostManager.TryBuyWithGold | H GoldBalance, cost | Gold 차감 후 boost +1 | TrySpend와 Grant 별도 H SaveAsync | 중간 종료/경합 시 partial grant |
| IAP callback ★ | GameSceneEntryPoint.OnPurchased | product ID; callback | H GoldBalance/boosts/NoAds/Starter flag | 여러 H SaveAsync; 거래 ID receipt 없음 | legacy handler; Journey 보상 연결 아님 |
| Xsolla purchase | ShopScreen.BuyProduct | SKU/native SDK catalog | SDK 구매 결과 callback만 | J/H 재화 grant 연결 없음 | 컴파일 조건 iOS/macOS; 일반 Journey shop 아님 |
| ad reward | AdManager.ShowRewarded | SDK callback, 단일 _rewardCb | 성공 event와 callback; legacy WinScreen에서 Gold 추가 가능 | caller H GoldManager.SaveAsync | config rewarded=0; J grant 없음 |

## Wallet writer 전체 맵

- **Energy**: 자연 충전, 유료 Diamond 교환, DROP 차감/취소 환불, Star 완성, Shield overflow, legacy deferred Camel/Shield, 거리 chest, 신규/개발 seed 및 legacy missing-field migration.
- **YallaPoint**: EnergyDrop 결과, legacy betting/session, 시설 구매, Raid 성공, Jackpot spin/legacy 이전, World chest. 현재 잔액은 EnergyDropSnapshot.ConfirmedYallaPoint이며 SessionState.YallaPoint는 복제다.
- **Diamond**: 신규/legacy Gold 이전/개발 지급, PurchaseEnergy 차감. 실제 결제 Diamond grant 없음.
- **J Gold**: legacy tier Collection reward, pending legacy Jackpot → YallaPoint 이전 차감. **H GoldBalance**: Bootstrap 시작 보너스, legacy levels/daily/login/boost 구매/IAP/ad. **PlayerWallet.Gold/Water**: 메모리 전용.
- **tickets/Shield**: Collection 획득, Raid/Jackpot 소비, 명시 uncapped Shield grant, 개발 Jackpot tickets. 실제 플레이어 Shield 소비/PvP 피해·재화 약탈 없음.

경제+진행을 함께 쓰는 경로의 완전한 범주는 DROP 예약/취소(복원 checkpoint), 라운드 확정, 거리 grant/chest, 시설 건설, World 완료, Collection legacy claim/이전 권리 지급, Raid 공격, Jackpot spin/이전, 신규/migration 및 H의 level/daily/boost/IAP 복합 보상이다. World 이동·장착은 보통 잔액을 바꾸지 않지만 Save의 recharge가 동반될 수 있다.
