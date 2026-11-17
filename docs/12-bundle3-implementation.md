# Bundle 3 — World / Building / Progress / Reward 서버 이전

2026-11-17, Asia/Dubai.

Backend `/Users/lewis/Developer/yalla-backend`, Unity `/Users/lewis/Developer/YallaJourney`.

## 완료 범위 / 체크포인트

시작 기준 Backend `7e0dde0`, Unity `e1d721d`. Bundle 2.1은 이미 커밋·푸시됐고 양쪽 origin/main과 차이 0/0이었다. 기존 Unity 미추적 백업/캐시/중복 backend 문서는 보존했다. 이번 Bundle 3 변경은 작업 트리에 있으며 추가 커밋/푸시는 실행하지 않았다.

World 100개, World당 건물 5개, 내부 레벨 1~5를 지원하는 Config/서버 진행/거래와 Unity 연결을 구현했다. 실제 AWS dev에서 **돈 획득 → 구매 20회 → 5개 MAX → COMPLETE → 보상 1회 → World 2 해금·이동 → 저장·재접속**을 검증했다. 단순 API 생성만으로 완료 판정하지 않았다.

사용자 확인 정책: **완료 World 재방문·선택·재건축 불가.** 완료 기록/MAX 건물은 보존한다. 다음 World는 5개 Level 1로 시작한다. World 100은 완료 상태를 유지한다. 원래 지시의 재방문 항목은 이 추가 확인에 따라 '거절되는지' 검증했다.

- 기존 AWS Stack `yalla-dev-bundle1` 업데이트 성공.
- Region `ap-south-1`, Profile `yalla-dev`.
- API https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com
- PlayerTable `yalla-dev-bundle1-PlayerTable-1TPG03GJPKOHQ` 유지.
- 기존 Player/Wallet/인증 초기화·local save import·테이블 재구축 없음. EC2/RDS/NAT Gateway 추가 없음.
- Unity GUI/Test Runner/Unity batch process/iPhone 빌드·실행 없음.

## Phase 0: 실제 규칙과 아트

근거: `MyShelterWorlds.cs`, `MyShelterProgress.cs`, `ShelterUpgradeCosts.cs`, `YallaJourneyPlayerData.cs`, `YallaJourneyPlayerStore.cs`, `MyShelterGrowth.cs`, `MyShelterSceneTransition.cs`, `WorldJourneyScreen.cs`, 실제 MyShelter/WorldJourney Scene.

- 기존 7개 ID/순서/이름: dunes/Dunes, canyon/Canyon, oasis/Oasis, bazaar/Bazaar, palace/Palace, nightcity/Night City, goldentemple/Golden Temple.
- 실제 건물 순서: Shelter, Ice Cream Shop, Clothing Shop, Water / Well, Treasury / Chest. 표시 이름은 기존 Raid 시설 이름과 대응한다.
- 초기 Level 1은 미건설 상태다. 기존 Sprite 4개는 Level 2~5에 대응하며, Level 1 화면에서는 다음 Sprite를 기존 반투명 preview로 보여준다. 새 Level 0/아트는 만들지 않았다.
- 업그레이드 1→2→3→4→5 각각 YallaPoint 10. 건물 5개 MAX에 구매 20회/총 200. 구매마다 기존 Construction Star 1도 같은 트랜잭션으로 유지했다.
- 실제 코드의 World 완료 보상은 **최초 완료 YallaPoint 100**, World당 한 번. Costume 보상 pool은 없었다.
- `AllVillagesComplete`는 이미 `IsVillageComplete` 즉 현재 건물 5개 MAX를 가리킨다. 완료 시 Village 2..5를 순회하는 새 진행은 구현하지 않았다.
- LegacyVillageCount=15/CurrentVillage/ProgressVersion=2/이전 좌표 변환은 기존 Save·Raid 호환을 위해 보존한다. 기존 서버 village 값은 읽기/진행 시 초기화하지 않으며, 새 World 진입 때 호환 필드 village=1을 쓴다. 신규 별도 Village 진행 단위는 없다.
- World Map은 이미 100개의 논리 위치와 작은 재사용 row pool을 사용했다. 기존에는 현재 World만 선택 가능했다. 이 동작을 사용자 확인한 일방향 정책으로 유지했다.
- 실제 건물 아트 7세트, 140개 Sprite 단계(7×5×4)를 확인했다. 파일/GUID뿐 아니라 씬의 정확한 fileID도 추출했다. Dunes에는 21300000 이외의 sub-Sprite fileID도 있으므로 GUID만으로 식별하지 않는다.
- 썸네일 파일/Map preview는 실제로 35번까지 있었다. 지시한 공개 범위는 1~30으로 적용하고 31~35 기존 파일은 삭제하지 않았다. 31~100은 hidden-map fallback을 참조한다.
- `docs/11-world-source-inventory.json`에 원본 경로/Asset Key/추출 수/기존 추가 preview 목록을 기록했다.

## S3 Config

공통 GameConfigs 로더(Zod, 환경 분리, Lambda별 60초 캐시, hash/논리 version, invalid 설정 fail-closed)를 재사용했다.

```text
s3://yalla-result-pools-533266967583/game-config/dev/v1/world.json
s3://yalla-result-pools-533266967583/game-config/dev/v1/world-buildings.json
s3://yalla-result-pools-533266967583/game-config/dev/v1/world-rewards.json
```

버전 `world-v1`, `world-buildings-v1`, `world-rewards-v1`, 공통 `releaseId=world-bundle-v1`.

각 파일은 기존 envelope `{schemaVersion:1,environment:"dev",version,data}`를 사용한다. 기존 Result Pool과 Bundle 2.1 Config 4개는 수정하지 않았다.

### world.json

100개 각각 `id`, `order`, `displayName`, `enabled`, `contentState`, `objectSetKey`, `backgroundAssetKey`, `thumbnailAssetKey`, `fallbackAssetKey`, `fallbackObjectSetKey`, `unlockAfterWorldId`, `nextWorldId`, `completionCondition=ALL_BUILDINGS_MAX`, `rewardKey`, `overrides`.

처음 7개 ID를 유지하고 8~100 ID는 `world-008`..`world-100`으로 분리했다. 이름/표시 순서는 독립 필드다. 미래 World의 기존 preview 이름은 표시 메타데이터이며 실제 콘텐츠 공개 승인이 아니다.

World 1~7만 enabled/READY. World 8~100은 PLANNED/disabled다. 전용 아트를 꾸미거나 미확정 보상을 0원 확정으로 간주하지 않는다. 명시적으로 기존 objectSet을 재사용하고 보상을 확인한 후 공개할 수 있다.

첫 7개 순서는 보존하고, 전체 ID/order 유일성, 시작/종료, next/prerequisite 양방향 일치, cycle을 검증한다. World 100의 next는 null이다. 진행 해금과 콘텐츠 공개는 구분한다. World 7 완료로 World 8의 진행 해금 기록이 생겨도, 콘텐츠가 PLANNED이면 진입·구매·완료는 불가하다.

### world-buildings.json

- `defaults`: initialLevel=1, maxLevel=5, upgradePrices=[10,10,10,10], 건물 5개 ID/표시 이름/order/구매 조건/레벨 정의/layout.
- `objectSets`: 기존 7세트의 background와 건물별 5개 슬롯. 첫 슬롯은 null(미건설), 나머지 4개는 실제 Asset Key.
- `worldOverrides`: World별 가격 또는 buildingOverrides(이름/가격/레벨 Asset Key/layout).
- layout은 anchoredPosition/sizeDelta/rotation/siblingIndex가 필요할 때만 적용한다. 현재 Config는 null이며 씬의 기존 배치를 유지한다.
- Prefab Asset Key는 nullable다. 실제 현재 건물은 UI Image/Sprite이므로 Prefab을 임의 추가하지 않았다. resolver에는 기존 등록 Prefab lookup 경계도 마련했다.

100개 World에 2,500개 레벨 레코드를 중복 작성하지 않는다. 공통 건물·가격·레벨 5×5와 7개 실제 아트 세트, World별 override로 해석한다. 총 논리 건물 슬롯 500, 레벨 슬롯 2,500이다.

### world-rewards.json

100개 각각 `{worldId,confirmed,completionRewards:[{type,amount?,itemId?}]}`.

- World 1~7: confirmed=true, `[{type:"YALLA_POINT",amount:100}]` — 실제 기존 정책.
- World 8~100: confirmed=false, [] — **보상 미확정 상태**, 무보상 확정이 아니다.
- 실제 지급 지원: ENERGY, YALLA_POINT, DIAMOND, 여러 보상 동시 지급.
- COSTUME_ITEM/기타 향후 유형은 메타데이터로 표현할 수 있지만 미지원이다. 포함된 World는 playable=false/명확한 blockedReason을 반환하고 거래를 거절한다. 지원 보상만 일부 지급하는 처리를 하지 않는다.
- World별 rewardKey를 사용하며, 공통 보상을 모든 100개에 암묵 적용하지 않는다.

서버 `playable`은 enabled/READY/유효 objectSet/보상 confirmed/모든 보상 지급 지원을 만족해야 true다. 차단 이유 WORLD_DISABLED/WORLD_CONTENT_NOT_READY/WORLD_REWARD_UNCONFIRMED/WORLD_REWARD_UNSUPPORTED를 반환한다.

## 설정 동시성 / 복구

세 파일의 SHA-256으로 `catalog.revision`을 계산한다. 관련 파일의 releaseId가 서로 다르면 `503 WORLD_CONFIG_INVALID`로 막는다. 단순 가격 수정과 구조 변경 release의 운영 범위를 구분할 수 있다.

구매/COMPLETE/select 요청에는 화면에서 받은 configRevision을 포함한다. 서버가 처음 요청을 수락할 때 조건/잔액을 검증하고, `WORLD#REQUEST#<requestId>`에 실제 가격/World 정의/보상/configVersions/configHashes/현재 run checkpoint를 저장한다. 그 뒤 잔액 변경을 수행한다. 응답 유실·강제 종료·설정 변경 후 재시도에서도 이 pin을 사용한다. 같은 ID/다른 입력은 409. 수락 전 설정이 바뀌면 CONFIG_CHANGED이며 새 가격으로 자동 청구하지 않는다.

`publish_game_config.py`는 version 증가+ETag 조건부 교체를 사용한다. 변경 전 JSON을 `game-config/dev/history/<name>/<version>-<sha>.json`에 먼저 archive한다. 최초 생성은 기존과 동일하게 If-None-Match:*다. rollback은 archive 내용을 확인해 새 논리 version으로 되돌리고, 구조 변경이면 세 파일의 releaseId를 일치시켜 게시한다. 이미 지급한 완료 보상은 rollback/버전 변경으로 다시 지급하지 않는다. 이번에는 신규 3개 파일 생성만 실행했으며 실제 설정 교체/rollback 대기는 하지 않았다.

## DynamoDB / 기존 Progress 호환

기존 PLAYER#<playerId> PK를 그대로 사용한다.

| SK | 의미 |
|---|---|
| PROGRESS | 현재 worldId, facilityLevels 5개, worldRunId/worldRunComplete, 완료 counts, 최고 해금 위치, 기존 거리/상자/star 필드 |
| WORLD#<worldId> | 실제 변경/진입한 World의 독립 levels/status/rewardClaimed/completionRewards/완료 시각 및 설정 정보 |
| WORLD#UNLOCKS | 실제 해금된 World ID 목록, version/updatedAt |
| WORLD#REQUEST#<requestId> | 수락된 구매/완료/이동의 고정 설정/입력 hash/checkpoint |
| ECONOMY#OP#world:<requestId> | 거래 영수증, 실제 금액/설정/잔액 전후/결과 |
| ECONOMY#CAUSE#world-complete:<worldId> | World당 한 번의 완료 보상 원인 |

현재 World가 아직 별도 item에 없으면 기존 Progress의 실제 레벨을 baseline으로 읽는다. 100개 World의 초기 건물을 플레이어마다 생성하지 않는다. 첫 변경 때만 World item을 저장한다. 완료 World의 MAX 건물/지급 결과를 남기고 다음 World item을 Level 1로 별도 생성한다.

기존 Save/Profile/Wallet 응답 형태와 schemaVersion=1은 유지했다. worldId 허용 범위를 100개로, highestUnlockedWorld를 0..99로 확장했다. `worldId`가 CurrentWorldId 역할을 한다. `village`는 호환 필드이며 새 진행 단위가 아니다. 별도 UI snapshot에는 정확한 unlockedWorldIds를 제공한다.

기존 완료 counts가 있는 World는 소급 보상을 지급하지 않는다. 로컬 Save를 서버로 가져오거나 초기 잔액을 합산하지 않는다. 새 방식의 완료는 run/request ID와 무관한 World-scoped cause로 한 번만 지급한다.

구매는 Wallet+Progress+World level+Session version+영수증/cause를 한 트랜잭션으로 저장한다. 완료도 Wallet(복수 통화)+Progress+완료 World 기록+해금+Session+영수증/cause를 한 트랜잭션으로 저장한다. 다음 World 이동은 연출 뒤 별도 멱등 select command로 현재 포인터와 새 World level을 원자 변경한다. Session 자체나 현재 YallaPoint를 재초기화하지 않는다.

Drop pending 또는 활성 보너스/Raid와 World 변경을 충돌시키지 않는다. 같은 Session version을 잠그므로 동시에 검증을 통과해도 한 거래가 먼저 확정되고 다른 요청은 다시 상태를 검사한다. Bundle 2.1의 Raid 배수/초기 봇/약탈 가격, Drop/Collection/Jackpot/Journey 정책은 수정하지 않았다.

## API

기존 Cognito access JWT / Player 소유권 검사 / no-store / `{error:CODE}` 사용.

| 메서드/경로 | 요청 |
|---|---|
| GET /worlds/state | 없음 |
| POST /worlds/upgrade | `{requestId:UUID,worldId,buildingId:"building-1".."building-5",expectedLevel:1..5,configRevision:SHA256}` |
| POST /worlds/complete | `{requestId:UUID,worldId,configRevision}` |
| POST /worlds/select | `{requestId:UUID,worldId,configRevision}` — 현재 완료 World의 정확한 다음 World만 가능 |

성공 HTTP 200:

```ts
{
 session, round, save:{profile,progress,wallet}, collection, serverTime, // 기존 Drop snapshot
 worldState:{worldId,levels,status,rewardClaimed,completionRewards,...metadata},
 unlockedWorldIds:string[],
 currentWorld:{...WorldDefinition,buildings:ResolvedBuilding[5]},
 catalog:{releaseId,revision,versions,hashes,worlds:WorldSummary[100]},
 result?:{type,worldId,buildingId?,fromLevel?,toLevel?,cost?,completionRewards?,nextWorldId?,configVersions,configHashes},
 replayed?:boolean
}
```

전체 100개 World의 resolved 건물 2,500개를 매 응답마다 반복 전송하지 않고, 100개 요약과 현재 World의 5개 resolved 건물만 반환한다.

주요 409: CONFIG_CHANGED, INSUFFICIENT_YALLA_POINT, BUILDING_MAX, STALE_BUILDING_LEVEL, WORLD_NOT_MAX, WORLD_NOT_CURRENT, WORLD_CHECKPOINT_CHANGED, COMPLETE_CURRENT_WORLD_FIRST, WORLD_SELECTION_FORBIDDEN, WORLD_DISABLED, WORLD_REWARD_UNCONFIRMED, WORLD_REWARD_UNSUPPORTED, ROUND_PENDING, BONUS_ACTIVE. 다른 소유자/미인증은 기존 404/401 규칙을 따른다. MAX/잘못된 ID/부족 잔액/잠긴 World는 지급·레벨 변경 전에 거절한다.

## Unity 연결 / 아트 fallback / 로컬 보호

- `ServerWorldClient`: 비동기 state/upgrade/complete/select, ownership 검증, 별도 `yalla-server-world-v1-<playerId>.json` journal. 요청 ID/입력을 첫 HTTP 전에 원자 저장한다. 재시작/네트워크 실패 때 같은 요청을 복구하고, 확정적인 거절이면 새 snapshot만 수락한다.
- `WorldAssetCatalog`: Resources의 작은 ScriptableObject가 기존 Sprite를 `sprite/<guid>/<fileID>`에 연결한다. 178개 기존 Asset Key/경로를 검증했다. 미등록 key는 선언 fallback, 마지막으로 기존 authored Dunes/hidden-map Sprite로 내려가며 원격 다운로드/이미지 생성/Addressables 추가 없음.
- MyShelterGrowth: 서버 응답 이후만 레벨/Wallet/Construction Star/건설 effect를 갱신한다. Config 가격/아트/layout/order를 기존 5개 view에 적용한다. default layout은 바꾸지 않고, override를 바꿀 때 기존 authored pose를 기준으로 복원한다.
- COMPLETE는 기존 LateUpdate의 MAX 감지 경로를 유지하되 **서버 완료 확정 후** 기존 overlay/이동 연출을 시작한다. 실패하면 기존 상태를 유지하고 재조회/재시도한다.
- MyShelterSceneTransition: 기존 Dust/Caravan/Map 전환 뒤 서버 select. World 7 다음이 콘텐츠 미준비면 이동하지 않고 완료 World를 보존한다. World 100도 완료 상태로 남는다.
- WorldJourneyScreen/Transition: 100개 row pool/UI 유지, 서버 이름/썸네일/정확한 해금·공개 상태/next link 반영. 과거 완료 World 버튼을 활성화하지 않는다.
- MyShelterWorlds: 100개 ID/서버 표시 이름 경계 확장. 기존 legacy 15/5 좌표 migration은 실제 7개 legacy 배열로 제한하여 보존한다.
- YallaJourneyPlayerStore.Server: 서버 World·건물·완료·star·Wallet을 화면에 투영한다. Profile.WorldId도 원래 로컬 값으로 보존하며, 서버 투영이 로컬 Save의 World/경제 필드에 저장되지 않도록 보호한다.
- 기존 동기 UpgradeShelter/CompleteShelterWorld/StartShelterWorld는 삭제하지 않았고 온라인에서는 명시적으로 거부한다. 서버 오류를 로컬 청구/완료 보상으로 대체하지 않는다.
- 기존 Scene/Prefab 파일은 수정하지 않았다. 신규 Resource asset은 기존 이미지에 대한 참조 catalog이며 새 아트가 아니다.

## 검증 결과

- TypeScript typecheck/build 통과.
- 기존 Bundle 1~2.1 회귀와 World 검사 **77/77 통과**. 배포 전 전체 빠른 실행 755ms. 장시간 테스트/Unity Test Runner 없음.
- World 1 기본값/20단계 성장/중복 구매/잔액 부족/MAX/잘못된 소유자·레벨/5개 MAX/중복 COMPLETE/다음 World 진입/재방문 거절/복수 통화·World별 상이한 보상/설정 변경 후 보상 보존/수락 가격 pin/commit 전후 timeout 복구 검사.
- World 7→8, 30→31, 99→100, World 100 종료는 **테스트 전용 synthetic ready 설정**으로 검사했다. 그 설정이나 새 보상 숫자는 S3에 게시하지 않았다. 실제 dev 미래 World는 잠겨 있다.
- asset audit: 7세트/140개 기존 건물 Sprite 단계, 178개 catalog key 모두 실제 파일 존재, 현재 World 31 썸네일 fallback, Scene/Prefab 변경 없음 확인.
- Unity 프로세스 없이 C# iOS development 소스 compile 통과. IL2CPP/native/iPhone 화면 성공으로 계산하지 않는다.
- 실제 AWS dev API/DynamoDB **33개 검사 통과**. 새 검증 Guest 한 명만 사용했고 기존 Player 데이터를 수정하지 않았다. DB에 잔액/MAX 레벨을 주입하지 않고 기존 Drop으로 돈을 벌어 구매했다.

실검증 Player `f74cf0e6-88c9-4e2a-84a4-602ec2e669ca`, Session `3c377ba8-9510-4d99-a1eb-98562dd3472a`, 완료 request `00c5d39d-a48f-4c53-9042-9843dd803e85`.

1. 기존 Drop 4회로 YallaPoint 240 획득. 테스트 actual은 RED/Star DTO였다.
2. World 1 구매 20회 ×10 =200 차감 → 40. 동시 중복 구매도 한 번만 차감.
3. COMPLETE +100 → 140. 같은/새 request ID 재제출 모두 추가 지급 없음.
4. Canyon 해금·이동. 기존 Dunes `[5,5,5,5,5]`, status COMPLETE/rewardClaimed를 DB에 보존.
5. Canyon 첫 건물 1→2, 10 차감 → **YallaPoint 130**.
6. 최종 Wallet **Energy 48 / Diamond 0 / YallaPoint 130**, Progress **canyon / [2,1,1,1,1] / village=1 / dunes 완료 count=1 / constructionStars=21**. 거리 240 유지.
7. 실제 refresh 재접속 후 값 유지, DDB Wallet/Progress/두 World item/완료 Config·보상 receipt/World-scoped cause 확인.

## 남은 제한 / iPhone 통합 QA

실제 iPhone UI·물리·IL2CPP 빌드는 사용자가 수행해야 한다. 다음을 인수 기준으로 확인한다.

1. 기존 Bundle ID/Keychain/Save를 유지하고 Development Build 설치. 기존 서버 Player가 복구되는지 확인.
2. 실제 Drop/Collection/Jackpot/Raid로 YallaPoint를 얻고 My Shelter에서 건물 구매. 서버 잔액 차감 후 기존 성장/Star/effect가 나오며 앱 재시작해도 레벨이 유지되는지 확인.
3. 카드 연타/구매 중 네트워크 차단/강제 종료 후 같은 구매를 두 번 청구하지 않는지 확인. 설정 변경 거절 시 새 가격으로 자동 재구매하지 않아야 한다.
4. 5개 MAX 후 서버 COMPLETE 성공 → 기존 완료/Map/Dust/Caravan → 다음 World의 5개 Level 1, 새 배경/아트를 확인. 보상 100이 한 번만 지급되는지 DB와 비교.
5. COMPLETE 직후와 이동 직전/직후 강제 종료 후 재접속. 완료 보상/이전 World MAX는 유지하고 이동 요청만 멱등 복구해야 한다. 완료 World 재방문 버튼은 없어야 한다.
6. World 7 경계는 현재 dev에서 World 8 콘텐츠 미준비 때문에 이동 불가가 정상이다. World 31 thumbnail은 기존 hidden-map fallback을 표시해야 한다. World 100 종료의 서버 논리는 unit fixture로 검증했으며 기기 실제 진행 검증은 아직 하지 않았다.
7. 왕복 후 Drop/AUTO/Collection/Jackpot/Raid/Journey/Wallet 동기화를 확인한다. JWT/Guest 키를 로그에 복사하지 않는다.

미제작 World의 전용 아트·확정 보상은 계속 운영 승인 대상이다. Costume/향후 보상 지급 기능을 임의로 추가하지 않았다. 기존 로컬 Save 이관/과거 로컬 건물·완료 기록 import도 수행하지 않았다. 서버 Progress는 현재 Bundle 1 값에서 계속 진행하며, 로컬 원본은 보존된다.

## 변경 파일

Backend:

- `/Users/lewis/Developer/yalla-backend/infra/bundle1.json`
- `/Users/lewis/Developer/yalla-backend/infra/generate.py`
- `/Users/lewis/Developer/yalla-backend/scripts/publish_game_config.py`
- `/Users/lewis/Developer/yalla-backend/src/game-config.ts`
- `/Users/lewis/Developer/yalla-backend/src/handler.ts`
- `/Users/lewis/Developer/yalla-backend/src/model.ts`
- `/Users/lewis/Developer/yalla-backend/config/dev/world-buildings.json`
- `/Users/lewis/Developer/yalla-backend/config/dev/world-rewards.json`
- `/Users/lewis/Developer/yalla-backend/config/dev/world.json`
- `/Users/lewis/Developer/yalla-backend/docs/11-world-source-inventory.json`
- `/Users/lewis/Developer/yalla-backend/docs/12-bundle3-implementation.md`
- `/Users/lewis/Developer/yalla-backend/scripts/extract_world_configs.py`
- `/Users/lewis/Developer/yalla-backend/scripts/smoke_bundle3.py`
- `/Users/lewis/Developer/yalla-backend/src/world-config.ts`
- `/Users/lewis/Developer/yalla-backend/src/world-ids.ts`
- `/Users/lewis/Developer/yalla-backend/src/world.ts`
- `/Users/lewis/Developer/yalla-backend/tests/world.test.ts`

Unity:

- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Backend/link.xml`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/MyShelterWorlds.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/YallaJourneyPlayerData.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.Server.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/YallaJourneyPlayerStore.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Journey/UI/WorldJourneySceneTransition.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Journey/UI/WorldJourneyScreen.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Shelter/UI/MyShelterGrowth.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Features/Shelter/UI/MyShelterSceneTransition.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Gameplay/Drop/Scripts/FiftyFiftyBettingController.Server.cs`
- `/Users/lewis/Developer/YallaJourney/Tools/Validation/BackendBundle2/compile.py`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/ServerWorldClient.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/ServerWorldClient.cs.meta`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/WorldAssetCatalog.cs`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Core/Data/WorldAssetCatalog.cs.meta`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Resources/WorldAssetCatalog.asset`
- `/Users/lewis/Developer/YallaJourney/Assets/YallaDrop/Resources/WorldAssetCatalog.asset.meta`
