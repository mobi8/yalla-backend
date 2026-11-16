# 04. Bundle 1 최소 AWS 데이터 모델

작성일: 2026-11-16 (Asia/Dubai). 기존 04 문서가 없어 새로 작성했다. 근거는 [01 데이터 인벤토리](01-data-inventory.md), [02 데이터 흐름](02-data-flows.md), [03 저장·위험](03-storage-and-risks.md)이며, Unity 코드 재검색 없이 작성한 **설계안**이다. 기존 게임 규칙과 초기 재화는 변경하지 않는다. 승패 결정·결과 풀·물리 로직은 제외한다.

## 1. 데이터 구조와 PK/SK

아래는 논리 item 예시다. 우선 동일 DynamoDB 키 공간으로 설명하며 물리 테이블 개수는 확정하지 않는다. `p123`은 서버 발급 Player ID, `s1`은 세션 ID다. 모든 상태 item에 `schemaVersion`, `version`, `updatedAt`을 둔다. `version`은 해당 item을 갱신할 때 증가하는 동시성 제어 값이다.

| 영역 | PK / SK 예시 | 최소 데이터 | 역할·갱신 시점 |
|---|---|---|---|
| Guest Player | `PLAYER#p123` / `PROFILE` | `playerId`, `accountType=guest`, `nickname`, `avatarId`, `createdAt`, `migrationState` | 최초 생성·원본 저장 이전 상태. World는 Progress가 소유 |
| 인증 주체 연결 | `AUTH#guest#<subject>` / `PLAYER` | `playerId`, `provider`, `createdAt` | 검증된 Guest 인증 주체를 Player ID에 연결. 추후 Apple/Google도 같은 연결 형식 사용 |
| 독립 Wallet | `PLAYER#p123` / `WALLET` | `energy`, `yallaPoint`, `diamond`, `energyRechargeAnchor`, `energyRechargeHighWater` | 재화의 유일한 현재 잔액. 세션 생성·삭제로 초기화하지 않음 |
| 활성 세션 제어 | `PLAYER#p123` / `SESSION#ACTIVE` | `sessionId` | 하나의 활성 세션 참조. 중복 기기에서 별도 활성 세션 생성 방지 |
| Session / Pending Drop | `PLAYER#p123` / `SESSION#s1` | `mode`, `currentRound`, `completedRounds`, `status`, `pendingDrop`, `recentConfirmedResults` | 입력 예약·취소·확정·재실행 복원. 현재 잔액은 저장하지 않음 |
| 기본 Progress | `PLAYER#p123` / `PROGRESS` | `worldId`, `village`, `facilityLevels`, `worldRunId`, `worldRunComplete`, `worldCompletionCounts`, `highestUnlockedWorld`, `distance`, `lastDistanceMilestone`, `constructionStars` | 건설·World 완료/이동·거리 증가. 현재 필드와 완료 기준 보전 |
| Economy 영수증·원장 | `PLAYER#p123` / `ECONOMY#OP#<operationId>` | `operationType`, `requestHash`, `causeKey`, `configVersion`, `deltas`, `balancesBefore/After`, `walletVersionAfter`, `result`, `committedAt` | 잔액 변경과 함께 생성하는 불변 거래 기록. 결과 재조회·중복 요청 응답에 사용 |
| 보상 원인 중복 방지 | `PLAYER#p123` / `ECONOMY#CAUSE#<causeKey>` | `operationId`, `requestHash` | 요청 ID를 새로 만들어도 같은 지급 원인을 두 번 적용하지 못하게 조건부 생성 |

`pendingDrop` 최소 내용은 `reservationId`, `round`, `energyCost`, `prediction`, `configVersion`이다. 클라이언트 복구에 필요한 기존 식별값은 그대로 보전하되 결과 풀의 내용·선택 방법은 서버 모델에 설계하지 않는다. `recentConfirmedResults`는 표시용이며 지급 원장이 아니다.

거리 `distance`는 기존 decimal 값을 정밀도 손실 없이 보존한다. 전송은 decimal 문자열, 저장은 정확한 decimal 변환을 사용하며 float/double을 거치지 않는다. 재화는 정수이며 기존 Unity int 허용 범위와 checked 계산을 유지한다. DB 숫자 범위가 더 넓다는 이유로 게임 상한을 확대하지 않는다.

### Guest ID와 추후 계정 연결

- 서버가 불변 `playerId`를 발급한다. 기존 `local:SHA256(SavePath)`와 HyperBase PlayerId는 이전 출처로만 기록하며 인증 자격으로 사용하지 않는다.
- Guest도 재실행 시 검증 가능한 인증 자격이 필요하다. Player ID를 아는 것만으로 해당 Wallet을 읽거나 변경할 수 없게 한다. 인증 공급자·자격 보관 방식은 미결정이다.
- Guest 생성 재시도는 동일 인증 subject에 대해 기존 Player ID를 반환한다. 연결 item의 부재 조건과 초기 PROFILE/WALLET/PROGRESS/생성 영수증을 하나의 트랜잭션으로 저장한다.
- Apple/Google 연결 시 검증된 provider subject를 **기존 Player ID**에 연결한다. 이미 다른 Player에 연결된 subject는 자동 덮어쓰기·Wallet 합산을 하지 않는다. 실제 연결 기능은 후속 범위다.

### Wallet과 세션의 분리 원칙

신규 유저는 확인된 현재 기준인 Energy 200, Diamond 20000, YallaPoint 0으로 시작한다. 기존 유저에게 이 초기값을 추가 지급하지 않는다. Energy 자연 충전은 cap 50, 10초당 3을 유지하며 보상·구매로 50을 넘은 잔액은 잘라내지 않는다. Diamond→Energy 교환은 기존 1:20과 20단위 구매를 유지한다.

기존 `EnergyDropSnapshot.ConfirmedYallaPoint`는 승인된 이전 절차에서 Wallet로 한 번 옮긴다. Session에는 현재 잔액의 쓰기 가능한 복제본을 두지 않는다. 기존 `SessionSnapshot`의 legacy 잔액과 합산하거나 새 세션을 열 때 tier 시작 재화를 지급하지 않는다. legacy 모드의 처리 정책은 아래 결정 사항으로 남긴다.

저장 위치 분리가 이용 조건 변경을 의미하지는 않는다. 현재 외부 YallaPoint 정산이 요구하는 resumable session·pending 없음 조건은 Session/활성 참조의 version 조건으로 유지한다. 이를 완화하는 것은 별도 정책 결정이다.

## 2. 갱신 관계

경제 상태를 쓰는 모든 기능은 아래 공통 Economy 경계를 통과한다. Unity가 새 잔액이나 보상 금액을 직접 지정하는 방식 대신, 원인과 기존 규칙을 기준으로 변경분을 검증한다. 결과 자체의 생성·진위 판정 방식은 이번 설계에서 다루지 않는다.

| 이벤트 | 읽는 데이터 | 같은 트랜잭션에서 변경할 데이터 | 원인 중복 방지 예시 |
|---|---|---|---|
| 신규 Guest 생성 | 인증 연결 존재 여부 | 인증 연결 + Player + Wallet + Progress + 초기 지급 영수증/원인 | `starter#p123` |
| DROP 예약 | 활성 세션, round, Wallet Energy | Energy 차감 + pendingDrop 생성 + 영수증/원인 | `reserve#s1#round#reservationId` |
| DROP 취소 | 일치하는 pendingDrop | 예약 Energy 환불 + pending 제거 + 영수증/원인 | `cancel#reservationId` |
| 확정 결과 이후 정산 | 현재 예약, 확정 결과, Wallet, Progress | 기존 규칙의 YallaPoint 지급 + 거리/거리 chest Energy + round 전진 + pending 제거 + 영수증/원인 | `confirm#s1#round` |
| Energy 자연 충전 | Energy, anchor/high-water, 서버 UTC | 충전 잔액·checkpoint + 실제 지급이 있으면 영수증/원인 | 이전 Wallet version에 귀속한 충전 원인 |
| Energy 구매 | Diamond/Energy, 수량 | Diamond 차감 + Energy 증가 + 영수증/원인 | `energy-purchase#operationId` |
| Village 시설 건설 | 예상 World/run/village/level, 세션 조건, Wallet | YallaPoint 차감 + 시설 level/별 증가 + 영수증/원인 | `build#worldRunId#village#facility#fromLevel` |
| World 완료 | 시설 MAX, 현재 run, 최초 World chest 지급 여부 | 완료 횟수/해금/완료 flag + 첫 해당 World만 YallaPoint 지급 + 영수증/원인 | 완료 `world-complete#runId`; 보상 `world-chest#worldId` |
| World 이동·재방문 | 현재 완료 상태, unlock, 예상 run | World/run·시설 checkpoint 갱신; Wallet 잔액 유지 | Progress version 및 이전 run 조건 |
| 재실행·결과 재조회 | 활성 세션, Wallet, Progress, 기존 영수증 | 조회 자체는 재지급하지 않음; 충전은 별도 Economy 정산 | 기존 operation/예약 복원 |

예약 취소 후 같은 round를 다시 시작할 수 있으므로 `reservationId`는 시도마다 다르고 round 확정 원인은 고정한다. 취소와 확정이 동시에 오면 같은 Session version·pending 식별값 조건으로 하나만 성공한다. 재예약 전의 지연된 확정 요청은 새 예약 ID와 일치하지 않아 거절한다.

현재 World 완료는 시설 5개 MAX를 기준으로 한다. `village`는 기존 호환 checkpoint이며, 이름만 보고 Village 5개 완성 조건을 새로 만들지 않는다. 거리 chest는 300 단위마다 Energy 20, World chest는 해당 World 최초 1회 YallaPoint 100이라는 확인된 규칙을 유지한다. World 재방문 완료 횟수와 World chest 지급 여부는 서로 다른 원인 키로 관리한다.

Energy는 서버 UTC로 기존 recharge 계산 순서까지 보전해야 한다. 경제 명령에서는 관련 잔액 변경과 필요한 recharge 결과를 한 Wallet 갱신으로 묶고, 적용 순서를 `configVersion`에 고정한다. 화면 countdown은 Unity가 예측할 수 있지만 다음 명령의 기준은 서버 상태다.

## 3. 공통 Economy Transaction

다음은 API 구현이 아닌 모든 기능이 공유할 정산 계약이다.

| 단계 | 최소 계약 |
|---|---|
| 입력 | 인증으로 결정한 Player ID, `operationId`, operation 종류, `causeKey`, session/reservation 또는 world/run 식별값, 예상 version, 규칙 검증에 필요한 인수 |
| 재시도 검사 | 동일 operation ID와 동일 요청 hash면 저장된 결과 반환. 같은 ID에 다른 요청이면 충돌. hash는 명령 의미 인수로 만들며 전송 시각·retry 횟수는 제외 |
| 검증 | 필요한 최신 상태를 읽고 기존 게임 규칙·잔액 충분성·pending 상태·예상 run/level 확인. 클라이언트가 제출한 delta를 그대로 적용하지 않음 |
| commit | Wallet의 `version=읽은 값` 조건 및 잔액 범위 조건 + 관련 Session/Progress version 조건 + 영수증/원인 item 부재 조건을 **하나의 TransactWriteItems**에 포함 |
| 반환 | committed 결과, 변경한 item들의 version, Wallet 잔액, 지급 표시용 영수증. 애니메이션과 GET는 이미 지급한 결과를 표시·확인하며 재지급하지 않음 |

같은 Wallet에 여러 차감·지급이 있으면 항목별 delta를 영수증에 남기되 하나의 Wallet Update로 합친다. 같은 item의 조건은 해당 Update/Put에 포함한다. 거래 기록은 단순 합계뿐 아니라 `drop-reward`, `distance-chest`, `recharge` 같은 지급 원인을 구분해 남긴다. 현재 잔액의 기준은 Wallet, 거래 사실의 기준은 불변 영수증이다.

**동시 요청:** 서로 다른 operation이라도 동일 Wallet version을 읽었다면 한쪽만 성공한다. 실패한 쪽은 영수증 존재 여부를 먼저 조회한 뒤 최신 상태로 재검증한다. 이미 확정한 delta를 오래된 상태에 그대로 재적용하지 않는다. Session/Progress를 읽고 수정하지 않는 경우에도 이용 조건과 관련되면 transaction의 version 조건으로 보호한다.

**응답 유실:** timeout만으로 실패나 환불을 확정하지 않는다. 같은 operation ID의 영수증을 기본 키로 강한 일관성 조회하고, 없으면 같은 명령을 재시도한다. 요청 ID가 달라도 같은 지급 원인이 존재하면 그 영수증을 조회한다. 의미가 같으면 기존 결과를 반환하고, 다르면 충돌로 처리한다. 중복 판정에 비동기 조회용 인덱스를 사용하지 않는다.

**보존:** DynamoDB의 일시적인 요청 중복 방지만 의존하지 않고 영속 영수증과 원인 키를 둔다. 보상 원인 키를 TTL로 제거해 재지급을 허용하지 않는다. 상세 원장 보관 기간을 정하더라도 중복 방지 표식은 유지한다. 기존의 증가하는 receipt 배열을 Wallet/Progress item에 계속 누적하지 않는다.

**읽기:** 화면용으로 여러 item을 따로 읽은 값은 같은 시점의 snapshot이라고 가정하지 않는다. 경제 계산은 쓰기 시 version으로 검증하고, 일관된 복구 묶음이 필요한 경우 transactional read를 사용한다. 조회 응답이 늦게 도착하면 Unity는 더 오래된 version으로 현재 화면을 덮어쓰지 않는다.

## 4. 기존 데이터 이전과 책임 경계

- 기존 저장은 초기 지급과 구별한 `migration` 원인으로 한 번만 등록한다. 원본 hash·SaveRevision·기존 ID·변환 버전과 Player의 이전 완료 표식을 보전한다. 기존 영수증이 증명하는 지급 권리도 함께 이전해야 한다.
- `Energy=0`은 유지한다. 필드 누락 시 적용하는 기존 migration과 명시 null/손상은 구분한다. 손상된 값을 신규 기본 재화로 조용히 대체하지 않는다.
- pending DROP은 이미 차감된 상태로 옮기며 복원 시 다시 차감하지 않는다. 과거 거리/World chest baseline도 보전해 과거 진행에 보상을 다시 지급하지 않는다.
- 이전할 자료가 한 transaction에 담기지 않으면 Player를 `importing`으로 잠그고 검증된 자료를 준비한 후 완료 표식을 활성화한다. 완료 전에는 경제 명령을 받지 않는다. 이전 도중의 일부 데이터가 플레이 가능한 상태가 되지 않게 한다.
- 서버 권한 전환 후 Unity 로컬 파일은 cache/복구 참고 자료다. 로컬 recharge·starter·migration 결과를 매번 서버 잔액에 합산하지 않는다. 서버 전환 이전 원본을 반복 import하지 못하게 한다.
- 기존 J Gold, HyperBase GoldBalance와 SessionSnapshot 잔액은 서로 다른 의미다. 이번 최소 Wallet의 세 자산에 임의 합산·변환하지 않으며 원본을 보전하고 이전 정책을 먼저 결정한다.

## 5. 향후 확장 항목

| 항목 | 이번 설계에서 남기는 연결점 |
|---|---|
| Raid / Jackpot | 별도 실행 상태·ticket inventory·결과 영수증을 추가하되 잔액 변경은 공통 Economy transaction에 포함. 보상·소비 규칙은 기존 구현을 기준으로 후속 설계 |
| Collection | 심볼 진행·ticket/Shield·완성 권리를 추가하고 round 정산과 원자적으로 갱신. 거리 chest와 별도 권리이며 이번 단계에 새 지급 규칙을 추가하지 않음 |
| Costume | 소유권·장착 데이터를 Inventory로 확장. 현재 미구현인 구매·획득 규칙을 새로 만들지 않음 |
| Ranking | Progress/확정 기록을 활용할 후속 조회 모델. Scene 샘플을 실제 순위로 이전하지 않음 |

이 확장 항목들은 이번 문서에서 상세 모델이나 기능을 구현하지 않는다. 특히 기존 round 정산에는 Collection 변경도 포함되므로, 현재 게임에 서버 권한을 전환할 때는 이를 로컬 별도 commit으로 나누지 않도록 후속 설계를 완료해야 한다.

## 6. 구현 전 결정할 사항 — 최대 5개

1. **Guest 인증·복구:** 인증 공급자, iOS 자격 보관·재설치 시 복구 범위, 추후 Apple/Google 연결 충돌 처리.
2. **이전 기준:** 두 session 잔액의 채택 기준, J Gold/HyperBase 데이터의 보전 위치, pending·기존 receipt·개발 seed·손상 backup 처리. 합산이나 추가 지급은 승인 없이 하지 않는다.
3. **오프라인·정산 입력 경계:** 오프라인 경제 허용 여부와 기존 확정 결과를 서버가 받아들일 검증 계약. 승패·결과 풀·물리의 재설계는 제외한다.
4. **규칙 버전 전환:** 진행 중 예약에 적용할 config version, recharge 적용 순서, legacy 세션 처리. 확인된 수치와 이용 조건을 바꾸지 않는 호환 기준을 확정한다.
5. **저장·운영 범위:** 실제 조회량에 따른 테이블 분리 여부, 원장 상세 보관 기간, 기존 Collection과 원자적으로 연결한 뒤 서버 권한을 활성화할 시점. 중복 방지 표식은 보존한다.
