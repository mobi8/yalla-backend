# Yalla Journey 오류 처리와 복구

## 변경 전 기능별 점검

| 기능 | 실패 조건 | 기존 UI 반응 | 기존 재시도·복구 | 데이터 손실·중복 위험 |
| --- | --- | --- | --- | --- |
| 앱 시작 / Guest 인증 | 오프라인, Keychain 거부·손상, 만료된 토큰, Cognito 장애 | Guest observer는 개발 로그에 기록. Bootstrap에는 공통 복구 UI 없음 | 저장된 Guest 키 유지, 만료 토큰 갱신, 무효 refresh token이면 같은 Guest 키 사용. Observer는 2~60초 백오프 및 포그라운드 확인 | 로컬 키를 잃으면 기존 계정과 연결할 수 없음. 동일 키 재사용으로 반복 Guest 생성 위험 완화 |
| Player 데이터 로딩 | save 조회 실패, 형식 오류, 계정 불일치 | 개발 로그와 로딩 지연. 마지막 표시 상태가 남을 수 있음 | 인증 갱신 후 GET 또는 observer 재실행 | 계정 불일치와 누락 잔액을 거부. 상태 갱신이 늦어질 수 있음 |
| Wallet / Energy | Wallet 버전·스냅샷 실패, 충전 조회 지연, 에너지 부족 | 기존 잔액/충전 타이머와 Drop 버튼 상태. 통신 실패는 로그 | Drop 준비 및 Wallet 폴링, 서버 스냅샷 버전 확인 | 캐시된 잔액이 지연되어 보일 수 있음. 예약·환불은 서버 처리 |
| Session / Drop | 활성 세션 조회·생성 실패, 예약 응답 유실, 물리 타임아웃 | Drop 잠금 및 로그, 물리 실패 시 기존 라운드 복구 | 활성 라운드 조회, 저장된 issue ID 재사용, 동일 시드 재현, 서버 승인 취소 | 새 ID를 만들면 중복 예약 위험. 기존 서버는 하나의 pending 라운드와 요청 ID 검증으로 제한 |
| Settlement / Reward | POST 결과 전후 연결 유실, 저장 실패, 정산·취소 충돌 | 당첨 연출에 pending 표시, 실패 로그 | 저널에 실제 결과와 키 저장. 기본 복구는 같은 POST부터 실행하고 일부 충돌에서 GET | 서버 트랜잭션으로 중복 지급 방지. 이전 클라이언트는 정산 완료 여부를 확인하기 전 쓰기를 재전송 |
| AUTO Mode | 예약·정산 실패, 오프라인, 보너스 상태 불일치 | 상태에 따라 버튼 잠금·보너스 일시정지. 반복 정산 실패 후 AUTO 종료 | Drop 컨트롤러 폴링과 저널 복구에 의존 | 새 라운드가 실제로 나가면 추가 Energy 소비. 서버 pending 제약이 동시 예약을 제한 |
| Village / World Progress | 상태 조회·업그레이드·수리 실패, 버전 충돌 | 화면별 처리 또는 마지막 마을 상태 유지 | 계정별 명령 저널과 요청 ID 재사용. 기존 refresh는 pending POST 먼저 실행 | 응답 유실 시 마을 상태 지연. 서버 멱등성 계약에 의존 |
| Collection / Jackpot / Raid | 보너스 상태 조회, 티켓·스핀·타깃·결과 요청 실패 | 화면별 상태 메시지. Jackpot에는 수동 재시도 문구 | 서버 보너스 GET과 계정별 명령 저널, 기존 키·입력 재사용 | 보너스 진행이 멈춰 보일 수 있음. 임의 재추첨·지급은 서버 상태와 영수증 검증에 의존 |
| Friends / Friend Rank | 검색·목록·랭크 GET 실패, 신청·수락 응답 유실 | Friends 상태 문구와 같은 작업 재시도. 서버 비즈니스 오류에 별도 문구 | 쓰기 요청에 요청 ID 사용. 기존 팝업 Retry는 이전 클로저 재실행 | 응답 유실 시 신청 여부가 불명확. 새 쓰기 전에 서버 관계 확인 필요 |
| CARAVAN Rank / Activity | 랭킹·활동 GET, 커서·스코프 불일치 | 기존 페이지별 오류 및 Retry | 해당 탭/페이지 재조회. 커서 스코프 변경 처리 | 조회 전용. 마지막 목록이 오래될 수 있으나 재화 변경 없음 |
| Shop / IAP / Ads | 결제 취소·오류, 광고 SDK 준비·표시·보상 콜백 실패 | Xsolla 상태/로그와 RevenueCat 초기화, 광고 호출자에 실패 반환 | 광고 SDK 로드 백오프, 결제는 SDK 흐름. 광고 콜백 이후 AWS 보상 조회 API는 확인되지 않음 | SDK 응답 유실을 AWS에서 확인할 수 없어 전달·지급 보장 검증 필요 |
| Costume / Inventory | 재화 부족, 가격 변경, 구매·장착 응답 유실 | 구매 모달 상태, 인벤토리 갱신 시도 및 로그 | ServerBonusClient 저널과 인벤토리 확인 | 재고 표시 지연. 구매 중복 차감 방지는 원래 명령·키와 서버 동작에 의존 |
| Save / Sync | 파일 쓰기 실패·손상, 스냅샷 버전 불일치 | 로컬 SaveManager 로그, 서버 스냅샷 표시 지연 | 로컬 백업 파일 로드, 서버 상태 재조회 및 계정별 저널 | 로컬 파일 두 사본 손상 시 로컬 설정/저널 손실 가능. 로컬 잔액은 AWS로 업로드하지 않음 |
| Notification Hub | 알림 권한 거부, 토큰 등록 실패, APNs/SQS 오류 | OS 권한 UI, 백그라운드 경로는 일반적으로 사용자 팝업 없음 | iOS 등록 실패 후 30초. 서버 라우터와 워커가 등록·발송 및 실패를 처리 | 알림 지연·유실 가능. 푸시 수신만으로 재화 변경하지 않음 |

조사 기준은 Unity의 `Core/Backend`, `Core/Data`, Drop 컨트롤러, 각 기능 UI와 SDK 어댑터, 그리고 AWS Lambda의 `src/handler.ts`, `drop.ts`, `world.ts`, `bonus.ts`, `friends.ts`, `journey-read.ts`, `notification-*.ts`이다.

## 공통 UI와 오류 코드

`GlobalErrorManager`는 활성 오류 한 건과 복구 콜백을 보유한다. 씬 간 유지되는 공통 `YallaErrorPopup.prefab` 하나를 사용한다. Safe Area, 크림·브라운·골드, 상위 Canvas, 모달 입력 차단, UI 포커스 복원, Retry 실행 중 비활성화 및 0.8초 표시 유예를 적용한다. 기능별 모달은 닫을 수 있고, 토스트는 입력을 차단하지 않는다. 공통 UI를 사용하지 않는 기존 기능은 기존 페이지 메시지를 사용한다.

| 코드 | 표시 및 버튼 |
| --- | --- |
| NO_INTERNET | NO INTERNET · Retry |
| CONNECTION_LOST | CONNECTION LOST · Retry |
| TIMEOUT | CONNECTION TIMED OUT · Retry |
| SERVER_UNAVAILABLE | SERVER UNAVAILABLE · Retry |
| MAINTENANCE | MAINTENANCE · Retry |
| UPDATE_REQUIRED | UPDATE REQUIRED · 앱 스토어에서 업데이트하라는 안내. 배포 URL 연결은 미구현 |
| AUTH_EXPIRED | SESSION EXPIRED · Retry |
| DATA_LOAD_FAILED | COULDN'T LOAD DATA · Retry |
| SAVE_FAILED | COULDN'T CONFIRM SAVE · 상태 조회 복구 콜백이 존재하면 Retry |
| SETTLEMENT_PENDING | RESULT PENDING · 정산 상태를 조회하는 Retry |
| REQUEST_FAILED | REQUEST FAILED · 기능 모달 또는 자동 닫힘 토스트 |
| RATE_LIMITED | PLEASE WAIT · Retry-After 또는 최소 대기 뒤 Retry |
| UNKNOWN_ERROR | SOMETHING WENT WRONG · 기능 모달 또는 토스트 |

앱 시작·Drop 상태 복구, 정산, 인증, 점검, 필수 업데이트는 전체 차단형으로 처리한다. Friends 조회 오류는 기능별 모달과 기존 인라인 상태로 표시한다. 보상형 광고가 준비되지 않았거나 SDK 표시가 실패하면 토스트를 표시한다. `MAINTENANCE`·`UPDATE_REQUIRED`는 명시적 서버 코드만 매핑하며, 현 AWS 배포에 이 신호를 추가하지 않았다.

## 네트워크와 정산 정책

- 앱 시작, 연결 유형 변경과 포그라운드 복귀에 기존 인증·save API로 확인한다. Reachability가 연결을 보고해도 DNS·TLS·캡티브 포털 문제는 실제 요청으로 감지한다. OS가 연결 없음으로 보고하면 새 요청과 게임 진행을 막는다. 네트워크 복구는 API 응답 또는 정산 상태로 확인한다.
- 전송 15초와 Drop 흐름 전체 20초의 기존 제한을 유지한다. GET은 네트워크·타임아웃·일부 5xx에 최대 2회, 0.5초와 1초의 지수 백오프로 재시도한다. 기존 호출의 취소/시간 제한이 우선한다. 429는 즉시 자동 재시도하지 않는다. 공통 UI와 Guest observer의 재시도 대기에 Retry-After를 반영한다.
- 공유 전송 계층은 쓰기를 자동으로 다시 보내지 않는다. 쓰기 401에서 액세스 토큰을 무효화하여 다음 복구에서 기존 Guest 인증을 다시 확인한다. Friends 쓰기 실패의 Retry는 관계 목록을 조회한다. World·Bonus 복구는 서버 상태 조회 후 기존 저널의 명령과 키를 사용한다. 현재 상태 응답은 모든 명령에 대한 개별 영수증 조회를 제공하지 않아 이 두 기능의 재전송 정합성은 기존 서버 계약에 의존한다.
- 정산 첫 POST 전에 결과·round ID·request ID·physics version을 계정별 저널에 기록한다. 실패 시 AUTO를 종료하고 새 Drop을 막는다. 복구에서 기존 round의 GET을 먼저 호출한다. SETTLED면 확인된 결과·잔액·진행을 복원하고, ISSUED면 같은 입력과 키만 사용한다. CANCELLED면 서버가 확정한 스냅샷을 반영한다. 조회 실패·식별자 불일치에서는 pending을 유지한다.
- 유실된 Drop 예약 응답은 기존 active 조회와 같은 예약 ID로 복구한다. 네트워크 장애 중 서버 진행을 로컬로 대체하거나 새 오프라인 재화 변경을 큐에 넣지 않는다. 기존 읽기 화면 데이터는 유지될 수 있다.

## 변경 파일

| 저장소 | 파일 |
| --- | --- |
| Unity 신규 | `Core/Backend/GlobalErrorManager.cs`, `Core/Backend/ErrorPopup.cs`, `Resources/YallaErrorPopup.prefab` 및 Unity 메타 파일 |
| Unity 수정 | `Core/Backend/{BackendContracts,BackendGuestObserver,GuestBackendClient,UnityBackendTransport}.cs`, `Core/Data/{ServerBonusClient,ServerWorldClient}.cs`, `Gameplay/Drop/Scripts/FiftyFiftyBettingController{,.Server}.cs`, `Features/Friends/UI/FriendsPopup.cs`, `Core/HyperBase/Monetization/AdManager.cs`, `Tests/Editor/{BackendBundle1Tests,FiftyFiftySettlementTests}.cs`, `Editor/DeviceGuides.meta` |
| Backend | `tests/drop.test.ts`, 이 보고서 |

기존 API 경로·요청·응답 계약과 경제 산식으로 구현했다. AWS Production 배포는 0건이다.

## 검증과 iOS 출시 확인

- AWS Backend는 `YALLA_TEST_LOOPBACK=1 npm test` 152개와 `npm run typecheck`를 통과했다. 정산 커밋 후 소켓을 실제 종료해 HTTP 응답을 유실시키고, GET만으로 결과·Energy 47·Progress 15를 복구하며 정산 원인이 한 건인지 확인했다. 커밋 전 실패는 ISSUED를 유지했고 같은 결과를 재전송해도 한 번만 진행됐다. 기존 동시 요청, 보상 선택 재현, 예약 차감 및 취소 환불 중복 방지 테스트도 포함한다.
- Unity EditMode 결과 XML은 48/48 통과를 기록했다. Unity 실행기는 종료 정리 중 변경 불가 Xsolla 패키지의 `CONTRIBUTING.md` 메타데이터 누락을 오류로 처리해 종료 코드 3을 반환했다.
- Unity Mock에는 500·503 읽기 재시도, 429·Retry-After, 쓰기 401·503 비재전송, 인증·네트워크·정산 컨텍스트 분류, 공통 Prefab 리소스 확인과 Retry 연속 클릭 검증을 포함한다. 로컬 정산 테스트의 오래된 15라운드 픽스처를 현재 `MaxRound` 상수에 맞췄다. EditMode 종료를 막던 `DeviceGuides.meta`의 참조 없는 잘못된 폴더 GUID를 수정했다.
- iOS 실기기에서 첫 설치 후 비행기 모드로 시작, 로딩·친구 신청·AUTO·정산 도중 연결 차단, 반복 Retry 및 팝업 한 개 유지, Wi-Fi만 연결되고 인터넷이 없는 환경, Wi-Fi ↔ 셀룰러 전환, 백그라운드·프로세스 종료 후 저널 복원, 실제 DNS/TLS 실패, 노치·홈 인디케이터 및 다른 HUD 모달 위 입력을 확인해야 한다. 500/503/429/401은 스테이징 또는 Mock으로 주입한다.
- 광고 시청 직후 연결을 차단하고 콜백이 없는 경우와 구매 완료 직후 앱을 종료한 경우는 SDK 테스트 광고와 스토어 샌드박스에서 확인해야 한다. AWS에서 광고 지급을 조회하거나 결제를 검증하는 API는 이번 범위에서 추가하지 않았다.

| 검증 시나리오 | 로컬 결과 | iOS 실기기에서 이어서 확인 |
| --- | --- | --- |
| 인터넷 없이 실행 | NO_INTERNET 분류와 Guest 키 유지 Mock 통과 | 첫 설치와 기존 Guest 각각의 부팅 화면 및 Retry |
| 게임 중 비행기 모드, 로딩 중 연결 유실 | 읽기 타임아웃·장애 Mock 통과 | 앱의 입력 차단 시점과 캐시 화면 유지 |
| 정산 요청 후 응답 유실 | 커밋 전후 Mock 및 실제 로컬 HTTP 소켓 단절 통과 | 당첨 연출과 함께 차단한 뒤 결과 팝업과 Wallet 일치 |
| Retry 연속 클릭, 팝업 중복 생성 | 진행 중 Retry 콜백 한 번 호출, 공통 Prefab에 Canvas 하나 확인 | 동시 Guest / Drop 실패, HUD 모달 위 입력 및 중복 인스턴스 확인 |
| 500 / 503 / 429, 인증 만료 | 읽기 재시도, 429 즉시 재전송 금지, 쓰기 재전송 금지와 Guest 갱신 Mock 통과 | iOS에서 대기 문구, 복구, 세션 연속성 확인 |
| 친구 신청 중 단절 | Friends 테스트 통과. 쓰기 실패 시 Retry 코드 경로는 목록 조회 | 요청 직후 실제 차단, 받은 사람의 목록과 신청 상태 대조 |
| 광고 보상 확인 실패 | SDK 준비/표시 실패 토스트 연결. 지급 확인은 미검증 | 광고 완료와 보상 콜백 사이 단절, 늦은 콜백, 앱 복귀 |
| 백그라운드 전환, 네트워크 복구, AUTO 중 단절 | 포그라운드 API 확인 및 AUTO 중단 코드 연결 | 푸시 또는 홈 화면에서 복귀, 진행 중 예약 보존, 새 Drop 미발행 |
| 보상·차감 중복 방지 | 백엔드 동시 요청·재전송·정산 상태 테스트 통과 | 실제 이중 탭, 백그라운드 및 재실행 조합에서 잔액 비교 |
