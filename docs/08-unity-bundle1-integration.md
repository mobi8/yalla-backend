# Unity ↔ AWS Bundle 1 인증·조회 연동

작업일: 2026-11-16 (Asia/Dubai). 현재 연결 대상은 AWS dev이며 05·06·07 문서를 기준으로 구현했다.

## 구조·변경 범위

기존 `BootstrapEntryPoint`는 HyperBase Save 로드·서비스 초기화 후 FiftyFiftyScene으로 진입한다. 해당 씬의 `FiftyFiftyBettingController`는 Journey Store를 통해 로컬 Energy·recharge·YallaPoint·Session을 관리한다. 여기에 서버 Wallet을 대입하면 로컬 정산과 충돌하므로 기존 파일을 수정하지 않고 독립 observer를 추가했다.

`RuntimeInitializeOnLoadMethod(BeforeSceneLoad)`가 숨겨진 `DontDestroyOnLoad` 객체를 생성한다. 어떤 씬에서 Play해도 자동으로 인증·조회하며 게임 부트스트랩 완료를 기다리게 하거나 화면을 추가하지 않는다. 서버 조회에 실패해도 기존 로컬 Save 초기화·보상 정산·Energy·UI·씬 진입에는 관여하지 않는다.

Unity 프로젝트에 추가한 소스:

| 경로 (`~/Developer/YallaJourney` 기준) | 역할 |
|---|---|
| `Assets/YallaDrop/Core/Backend/BackendContracts.cs` | 서버 전용 Profile·Progress·Wallet DTO, 응답 검증. 거리 문자열을 C# decimal로 읽음 |
| `Assets/YallaDrop/Core/Backend/GuestBackendClient.cs` | 자격 생성·재사용, 직렬화된 refresh, 기존 키 재인증, 소유 Player 일치 확인 |
| `Assets/YallaDrop/Core/Backend/GuestKeychainStore.cs` | macOS Editor Keychain 및 iOS Keychain 저장소 |
| `Assets/YallaDrop/Core/Backend/UnityBackendTransport.cs` | 기존 API 계약의 HTTPS 요청, 15초 timeout, 기본 TLS 검증 유지 |
| `Assets/YallaDrop/Core/Backend/BackendGuestObserver.cs` | 자동 시작·재시도·복귀 처리·개발용 안전한 로그·서버 snapshot 보관 |
| `Assets/YallaDrop/Core/Backend/link.xml` | IL2CPP에서 JSON DTO 필드 보존 |
| `Assets/Plugins/iOS/YallaBackendKeychain.mm` | iOS Security.framework Keychain 브리지 |
| `Assets/YallaDrop/Editor/Backend/BackendIosFramework.cs` | iOS Xcode 내보내기 후 UnityFramework에 Security.framework 연결 |
| `Assets/YallaDrop/Editor/Backend/BackendBatchProbe.cs` | 명시적으로 실행할 때만 동작하는 GUI 없는 실제 연결 검사 |
| `Assets/YallaDrop/Tests/Editor/BackendBundle1Tests.cs` | fake 네트워크·메모리 저장소 기반 인증·오류 복구 검사 |
| `Tools/Validation/BackendBundle1/run.py` | 실제 프로젝트 C# 컴파일, 독립 테스트, iOS 브리지 구문 검사 |

Assets의 신규 파일·폴더 `.meta`도 함께 추가했다. 기존 Unity 소스·씬·프리팹·UI·Save는 수정하지 않았다. 작업 시작 전에 존재한 Jackpot/Journey UI 및 JourneyDistance 검증 도구의 미커밋 변경과 다른 미추적 파일은 유지했다. Backend의 API·초기 지급 정책·AWS 인프라는 변경하지 않았다.

## 인증·저장 동작

- 최초 실행에서 CSPRNG 32바이트 Guest 키를 만들고 **첫 HTTP 요청 전에 Keychain에 원자적으로 저장**한다. 요청 실패·응답 유실·강제 종료 때도 같은 키를 재사용한다.
- macOS Editor는 프로젝트 경로 해시·앱 식별자·dev 환경으로 구분한 login Keychain 항목을 사용한다. 비밀을 파일·PlayerPrefs·쉘 인자에 기록하지 않는다. Editor와 iPhone은 별도 Guest다. Editor 프로젝트 경로를 옮기면 별도 Keychain namespace가 된다.
- iOS는 앱 전용 Keychain에서 `WhenUnlockedThisDeviceOnly`로 보관하며 iCloud 동기화하지 않는다. Bundle ID·서명 접근 그룹 변경이나 자격 분실·재설치 복구는 별도 정책이며 강제 종료 후 재실행과 구분한다.
- Keychain에는 Guest 키·Refresh Token·소유 Player ID만 저장한다. Access Token은 메모리에만 둔다. 자격 손상·접근 거부·잠금은 신규 계정 생성으로 처리하지 않는다.
- 기존 Refresh Token이 있으면 `/auth/refresh`, 없거나 refresh가 400/401/403으로 거부되면 **기존 Guest 키로** `/auth/guest`를 호출한다. 통신·429·서버 오류는 자격을 유지하고 나중에 재시도한다.
- Access Token 만료 약 60초 전 또는 인증된 조회가 401일 때 갱신한다. refresh는 `SemaphoreSlim`으로 직렬화하고 회전된 토큰을 먼저 안전하게 저장한다.
- 인증 후 `GET /players/me/save`로 Profile·Progress·Wallet을 같은 snapshot으로 조회한다. Player ID가 저장된 소유 ID와 다르면 데이터를 수락하지 않는다.
- 서버 값은 `BackendGuestObserver.ServerSnapshot`과 개발 로그에만 보관한다. 로컬 게임 모델로 역직렬화하거나 잔액·진행을 덮어쓰지 않는다. 서버 잔액을 Unity 로컬 Save로 저장하는 API도 없다.
- 앱 pause·종료·강제 종료에서 logout을 호출하지 않는다. 종료 시 진행 중인 작업만 취소한다. 실패 후 재시도 간격은 최대 60초이고 foreground 복귀 시에도 다시 시도한다.
- 현재 macOS Editor와 iOS를 지원한다. 다른 Editor OS에서는 안전하지 않은 파일 저장으로 우회하지 않고 인증 observer만 실패하며 기존 게임은 유지한다.

현재 기본 endpoint: `https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com`. 운영 출시 전에는 운영 endpoint와 별도 Keychain 환경 namespace를 함께 설정해야 한다. 이번 작업은 운영 환경을 생성하거나 자동 선택하지 않는다.

## 완료한 검증

이미 통과한 검사를 연결 복구 후 다시 실행하지 않았다.

1. 실제 프로젝트 소스의 iOS development 심볼 C# 컴파일: 통과
2. 신규 모듈의 macOS Editor 심볼 C# 컴파일: 통과
3. 독립 NUnit assertion 기반 검사: **17/17 통과**
4. Editor 배치 검사·iOS postprocessor C# 컴파일: 통과
5. iPhoneOS SDK / arm64 Objective-C++ Keychain 브리지 구문 컴파일: 통과

독립 검사는 첫 네트워크 전 키 저장, 재실행 refresh 재사용, 통신 오류 시 키 보전, 만료·거부 토큰 복구, 동시 갱신 직렬화, 자격 손상·Keychain 잠금·저장 거부, 소유권 불일치, 누락 잔액 거부, decimal 정밀도·초과 Energy 보전, 비밀 없는 진단, 취소 시 요청·logout 없음까지 확인했다.

### Unity Test Runner 중단 기록

Unity 6000.3.11f1을 `-batchmode -nographics`로 실행했다. 프로젝트 로드·스크립트 컴파일 후 Test Runner가 시작됐지만, 약 15분간 진행 로그가 멈췄고 결과 XML이 생성되지 않았다. 2초 스택 표본에서 메인 스레드의 관리 코드 `Monitor_wait`/condition wait를 확인했다. 비동기 테스트 실행 컨텍스트의 대기 가능성이 있으나 관리 메서드가 심볼화되지 않아 정확한 원인은 확정하지 않았다. 마지막 MCP 콜백 로그만으로 해당 플러그인을 원인으로 단정하지 않는다.

해당 배치 PID만 명령행으로 확인하여 SIGTERM으로 종료했다. Test Runner 성공으로 계산하지 않으며 동일 테스트를 무한 재시도하지 않았다. 로그: `/tmp/yalla-bundle1-unity-tests.log`, 스택 표본: `/tmp/yalla-bundle1-test-hang.sample.txt`. 결과 XML은 없다. GUI는 실행하지 않았다.

### 실제 Editor Keychain + AWS 연결

Test Runner와 별도로, 프로세스 전체를 **120초로 제한**한 GUI 없는 배치 연결 검사를 최초 실행과 새 프로세스 재실행에 각각 수행했다. 두 번 모두 종료 코드 0으로 완료했다.

| 검사 | 결과 |
|---|---|
| 최초 `/auth/guest` | 201, `created=True`, `reusedCredential=False` |
| 최초 `/players/me/save` | 200 |
| 새 프로세스 `/auth/refresh` | 200, `created=False`, `reusedCredential=True` |
| 새 프로세스 `/players/me/save` | 200 |
| 두 프로세스의 Player ID | `e5be58dc-659d-40d5-83ff-13c57f5fc203`로 동일 |
| 두 프로세스의 서버 Wallet | Energy 50 / Diamond 0 / YallaPoint 0 |

Keychain에 실제 Editor 자격이 남아 있으므로 이후 정상 Play에서도 재사용한다. 비밀 값은 출력·문서화하지 않았다. 배치 검사는 게임 Play Mode로 진입하지 않았으므로 실제 Drop 플레이·UI 동작은 아직 수동 확인 대상이다.

배치 로그: `/tmp/yalla-bundle1-probe-first.log`, `/tmp/yalla-bundle1-probe-restart.log`.

AWS 읽기 전용 확인도 완료했다. 해당 Editor Player의 DynamoDB 상태 항목 5개(PROFILE·PROGRESS·WALLET·초기 영수증·원인 표식), Wallet 50/0/0, 초기 지급 영수증 1개를 확인했다. 인증 연결이 가리키는 Cognito Guest는 1명이며 `CONFIRMED`, enabled 상태다. 배치 검사 시간대의 CloudWatch API access log에는 `/auth/guest` 201 한 건, `/auth/refresh` 200 한 건, `/players/me/save` 200 두 건이 기록돼 있다. 확인 과정에서 AWS 리소스나 기존 게임 데이터를 변경하지 않았다.

## 개발 로그 확인

Unity Console 또는 Xcode 기기 로그에서 `[Backend Bundle1]`로 필터링한다. Editor 및 Development Build에서만 다음 정보를 출력한다.

- API 경로·응답 코드·안전한 오류 유형
- 인증 성공/실패, 신규 서버 계정 생성 여부, 저장 자격 재사용 여부
- Player ID 및 **서버** Energy / Diamond / YallaPoint

Guest 키·JWT·Refresh Token·원문 HTTP 응답·예외 메시지는 로그에 출력하지 않는다. 화면의 로컬 잔액이 서버 50/0/0과 다른 것은 이번 단계에서 정상이다.

## iOS 빌드 및 실기 테스트

실제 iPhone 설치·강제 종료 테스트와 실제 게임 플레이는 이번 자동 검사에서 수행하지 않았다.

1. Unity 6000.3.11f1의 iOS Build Profile에서 기존 Bundle ID와 씬 목록을 유지하고 **Development Build**를 사용해 Xcode 프로젝트를 내보낸다. 인증용 오브젝트·로그인 UI를 씬에 추가할 필요가 없다.
2. 내보낸 Xcode의 UnityFramework target에 `Security.framework`와 `YallaBackendKeychain.mm`이 포함됐는지 확인한다. postprocessor가 프레임워크를 추가한다. 앱 자체 Keychain 사용이므로 별도 공유 Keychain 그룹을 추가하지 않는다.
3. 기존 앱 Bundle ID·개발 팀·서명 프로비저닝을 맞추고, Developer Mode를 켠 iPhone을 선택해 설치·실행한다. ATS 예외나 HTTP 허용 설정을 추가하지 않는다.
4. 첫 실행의 `[Backend Bundle1]` 로그에서 Guest 성공, Player ID, 서버 50/0/0을 확인한다. 기기의 Player ID는 위 Editor ID와 달라야 한다.
5. 첫 성공 후 홈 화면 전환→복귀, 앱 강제 종료→재실행을 각각 수행한다. 로그의 Player ID가 기기 첫 ID와 같고 기존 자격을 재사용하는지 확인한다. 이 테스트에서는 앱을 삭제하거나 Bundle ID를 바꾸지 않는다.
6. 비행기 모드로 실행·복귀해도 기존 로컬 플레이·Save·Energy recharge·YallaPoint 정산이 유지되고 서버 실패 로그만 발생하는지 확인한다. 연결 복구 후 같은 Guest가 복원돼야 한다.
7. 로컬 게임의 DROP·보상·Energy 차감·Village/Collection/Costume/Raid와 로컬 Save 재실행 복원을 기존 방식으로 확인한다. 서버 Wallet 값으로 로컬 잔액을 덮거나 합산하면 안 된다.
8. AWS에서 기기 로그의 Player ID에 해당하는 DynamoDB `PLAYER#<id>`와 인증 연결·Cognito 사용자 상태를 확인하고, CloudWatch API access log에서 인증·조회 상태 코드를 시간대로 확인한다. 확인을 위해 비밀 키나 토큰을 복사해 로그에 남기지 않는다.

실제 전체 iOS 앱의 IL2CPP/Xcode 빌드·서명·실기 실행은 별도 검증이다. 이번 C# 및 native syntax 통과를 실기 빌드 성공으로 해석하지 않는다.

기술 근거: [Unity runtime 초기화](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/RuntimeInitializeOnLoadMethodAttribute.html), [UnityWebRequest timeout](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Networking.UnityWebRequest-timeout.html), [Apple Keychain 접근 제한](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly).
