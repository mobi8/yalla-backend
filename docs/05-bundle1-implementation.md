# Bundle 1 — Player / Save / Progress / Wallet / Guest authentication

기준: 04-aws-data-model.md. 01~04 원문은 변경하지 않았다. Unity는 읽기 전용으로 확인했다.

## Unity 대조 결과

| Unity 파일·필드 | 기존 동작 | 서버 모델·향후 Unity 연동 |
|---|---|---|
| `Core/Data/RaidState.cs` → `PlayerProfile` | `PlayerId`, `Nickname=YOU`, `AvatarId=ae6a6b0db4994642a1b45102daa825bd`, `WorldId=dunes` | 서버 UUID `playerId`, 같은 nickname/avatar 기본값. World는 04에 따라 Progress만 소유 |
| `YallaJourneyPlayerStore.Raid.cs` → `ProfileForUninitializedSave` | `local:SHA256(absolute SavePath)`를 Profile에 보관 | 경로 해시는 인증 자격이 아님. 서버 Player ID를 별도 보관하고 기존 ID는 향후 승인된 migration 출처로만 사용 |
| `YallaJourneyPlayerData.cs` 생성자 | Energy 200, Diamond 20000, Gold 0. EnergyDrop 최초 YallaPoint 0 | Wallet Energy 200, Diamond 20000, YallaPoint 0. Gold·HyperBase 잔액은 합산하지 않음 |
| `MyShelterProgress.cs`, `MyShelterWorlds.cs` | Village 1, 시설 5개 level 1. World 7개: dunes/canyon/oasis/bazaar/palace/nightcity/goldentemple | 동일 기본값·범위. `Profile.WorldId` → `progress.worldId`; `ShelterProgress.CurrentVillage/Levels` → `village/facilityLevels` |
| `YallaJourneyPlayerData.cs` World 메타데이터 | `WorldRunId=legacy:dunes`, 완료 false, counts={}, unlock index 0 | 기존 최초 run 값과 의미 보전. `schemaVersion`은 서버 스키마 버전이며 Unity의 `ProgressVersion=2`와 다른 개념 |
| `CamelJourneyProgress.Value` | C# decimal 거리 0. `LastGrantSessionId/Round`는 제한적인 과거 중복 방지 | `progress.distance`는 decimal 문자열 전송·DynamoDB 정확한 Number 저장. 기존 grant 필드를 지급 권리로 신뢰하지 않음 |
| `ConstructionStars`, `ChestRewards.LastDistanceMilestone` | C# long, 초기 0 | API에서는 손실 없는 정수 문자열. DynamoDB Number로 저장. 마일스톤 보전, 읽기로 보상 지급하지 않음 |
| `YallaJourneyPlayerStore.Load/Save` | 신규 파일 생성·초기 지급·migration·recharge가 Load 중 발생. Save는 revision 검사→tmp→replace/bak→observer | API 조회는 쓰기·지급·recharge 없음. Player/Progress/Wallet을 TransactGet으로 복원. 파일 revision 하나 대신 item별 version |
| `EnergyRecharge.cs` | Energy≥50이면 anchor=0, high-water=현재 UTC 초. 잔액 200을 cap으로 자르지 않음 | 신규 Wallet anchor 0, high-water 서버 UTC. 자연 충전 명령은 이번 범위 밖 |
| `Core/Development/JourneyPlayerDevelopmentSeed.cs` | 개발 전용 Diamond 100000·Collection seed. main/bak/tmp 존재 시 seed 방지 | 서버 초기값에 사용하지 않음 |
| `Editor/Journey/MyShelterDevelopmentReset.cs` | 시설·Village만 reset하고 Wallet·기타 원문·backup 보전 | 서버 reset API 없음. 로컬 reset이 서버 진행도·Wallet을 덮어쓰면 안 됨 |
| `FiftyFiftyBettingController.Session` 초기화 | 동기 `store.Load()` 후 `OpenEnergyDrop()`·로컬 Session 복원 | 향후 비동기 인증→서버 Save 복원→화면 projection으로 전환. Session 및 정산의 서버 전환은 후속 Bundle과 함께 적용 |

인증 관련 파일명 검색은 `Assets/YallaDrop` 아래의 관련 `.cs` 이름으로 제한했다. 실제 Guest/Cognito/Apple/Google 인증 구현은 해당 검색 범위에서 발견하지 못했다. Library/Temp/Packages/씬/프리팹/아트는 읽지 않았다. 전체 Unity 분석을 수행하지 않았다.

## 실제 Guest 인증 계약

Cognito User Pool의 native user를 Guest 인증 주체로 사용한다. Identity Pool은 사용하지 않는다. 클라이언트에 AWS access key/secret key 또는 app-client secret을 전달하지 않는다. User Pool Client는 secret 없는 public client이며 일반 self-signup은 비활성화한다. Guest 발급 Lambda만 Admin API로 사용자를 만든다.

1. Unity는 최초 실행 시 **CSPRNG 32바이트**를 생성하여 lowercase hex 64자로 변환한 `guestKey`를 **네트워크 요청 전에** Keychain/Android Keystore 기반 안전한 저장소에 보관한다. PlayerPrefs·Journey JSON·로그·analytics에는 기록하지 않는다.
2. `POST /auth/guest`에 `{ "guestKey": "<64 lowercase hex>" }`를 HTTPS로 전송한다. key는 공개 installation ID나 요청 ID가 아닌 장기 비밀 인증 자격이다.
3. 서버는 `guest_SHA256(guestKey)`를 Cognito username으로 만들고, 서버에서만 사용하는 고정 형식 password로 native user를 인증한다. key 원문이나 password는 서버 DB에 저장하지 않는다. Cognito가 password를 관리한다. 기기 ID·사용자 지정 Player ID를 받지 않는다.
4. Cognito subject에서 `AUTH#guest#<poolId>:<sub>`를 조회한다. `sub`는 불투명 식별자로 취급한다. 서버가 Player UUID를 별도로 발급하며 인증 subject와 게임 ID를 분리한다.
5. 인증 연결·PROFILE·PROGRESS·WALLET·초기 지급 영수증·원인 표식을 **한 번의 TransactWriteItems**로 생성한다. 모두 부재 조건을 건다. `starter#playerId`는 영구 보존하고 TTL을 두지 않는다.
6. 응답은 `{ created, save: { profile, progress, wallet }, tokens: { accessToken, idToken, refreshToken, expiresIn, tokenType } }`. 신규는 201, 기존 계정 복원은 200이다.
7. 이후 API는 `Authorization: Bearer <accessToken>`을 사용한다. API Gateway JWT authorizer는 issuer/client/서명/만료와 scope를 검사한다. Lambda는 access token 종류·issuer·client·만료를 다시 확인하고 인증 subject→연결 item으로만 소유자를 결정한다. 임의 Player ID 조회 API는 없다.
8. `POST /auth/refresh`에 `{refreshToken}`을 보내 갱신한다. **갱신 호출을 직렬화**하고 회전된 refresh token을 안전하게 교체한다. 응답 유실·만료 시 기존 guestKey로 다시 인증하면 동일 계정을 복구한다.
9. `POST /auth/logout`은 제출한 refresh token을 revoke한다. API Gateway의 자체 JWT 검증은 이미 발급된 access token을 만료 전에 즉시 취소하지 않으므로 이 API를 즉시 전체 접근 차단으로 해석하면 안 된다. guestKey는 별도 장기 자격이므로 이를 보유하면 재인증할 수 있다.

Cognito의 기본 access/id token 유효기간(1시간), refresh token 유효기간(30일)을 사용한다. refresh rotation을 활성화하며 재시도 grace는 10초다. 수명은 경제·게임 비즈니스 정책이 아니며 배포 설정으로 분리 가능하다.

**복구 한계:** guestKey와 refresh token을 모두 잃으면 Apple/Google 연결 전에는 인증을 증명할 수 없다. 재설치 시 Keychain 보존 여부·계정 복구 UX·분실 자격 지원 정책은 아직 정하지 않았다. 서버가 Player ID나 로컬 파일만으로 계정을 반환하지 않는다. 이 Bundle은 기존 로컬 save import를 구현하지 않는다.

## API

| Method / path | 인증 | 역할 |
|---|---|---|
| POST `/auth/guest` | guestKey 비밀 증명 | Guest 최초 생성 또는 동일 계정 재인증·복원 |
| POST `/auth/refresh` | refresh token | 토큰 갱신·회전 |
| POST `/auth/logout` | refresh token | 해당 갱신 자격 취소 |
| POST `/players/guest` | Cognito access token | 인증된 Guest의 원자적 provisioning 재시도. body는 `{}`만 허용 |
| GET `/players/me` | Cognito access token | PROFILE |
| GET `/players/me/progress` | Cognito access token | PROGRESS |
| GET `/players/me/wallet` | Cognito access token | WALLET |
| GET `/players/me/save` | Cognito access token | 세 상태를 같은 시점의 transaction snapshot으로 조회 |

Save는 조회 projection이다. Unity의 전체 JSON을 업로드하는 Save/PUT endpoint를 만들지 않는다. 시설·거리·World 변경은 후속 서버 명령과 Economy 정산으로만 가능하다. 이번 Bundle에서는 초기 저장과 복원을 구현한다. 초기 지급을 제외한 재화 변경·충전·결과 정산·Session·Raid·Inventory·Collection·결제·광고 보상은 구현하지 않는다.

정수 재화는 C# nonnegative int 범위를 지키며 거리와 long 필드는 JS float를 거치지 않는다. null/손상/불완전 상태는 신규 기본값으로 덮지 않고 오류를 반환한다. `migrationState=new`는 새 계정의 미이전 상태 표식이며 기존 유저 이전 완료를 의미하지 않는다. `starter-v1`은 04에서 확인한 초기 지급 구성을 고정한 기술 버전이다.

## 원자성·재시도·오류 복구

- Cognito와 DynamoDB는 분산 트랜잭션이 아니다. Cognito username은 guestKey에서 결정되므로 user 생성 직후·password 확정 직후·DynamoDB 장애·응답 유실 어느 단계든 같은 키로 다시 시작한다. 신규 키를 생성해 재시도하면 다른 계정이 되므로 금지한다.
- CONFIRMED 사용자의 password는 재시도 시 변경하지 않는다. 비활성 계정을 자동 활성화하지 않는다. 미완성 FORCE_CHANGE_PASSWORD만 같은 자격으로 완료한다.
- 동일 subject의 동시 최초 생성은 연결 item 부재 조건으로 하나만 성공한다. 실패/불명확한 결과는 강한 일관성으로 연결을 다시 조회해 승자의 Player를 반환한다. 아직 commit이 확인되지 않으면 오류를 반환하고 같은 자격으로 재시도한다.
- 모든 초기 기록은 부재 조건으로 보호된다. timeout을 초기 지급 실패/환불로 간주하지 않으며, 새로운 operation으로 추가 지급하지 않는다. 화면 조회도 지급하지 않는다.
- Lambda 역할은 해당 테이블의 GetItem과 transaction 안의 PutItem만 허용한다. Auth Lambda만 해당 User Pool의 필요한 Admin API를 호출할 수 있다. 게임 클라이언트는 DynamoDB와 IAM 자격에 접근하지 않는다.
- 400은 입력 오류, 401/403은 인증 오류, 404는 미생성·없는 경로, 429는 제한, 503은 재시도 가능한 실패다. 500/503·통신 실패도 같은 guestKey로 재시도한다. 상태 손상은 운영 확인이 필요하다.

## Apple / Google 연결점

native Guest Cognito user와 Player UUID를 유지하고 검증된 외부 provider subject를 기존 사용자에 연결한다. Cognito `AdminLinkProviderForUser`를 사용하며, 별도 provider mapping이 필요한 경우에도 기존 Player를 가리켜야 한다. 연결 전에 기존 Guest의 최근 인증 및 외부 provider 증명을 모두 검증한다. 다른 Player에 연결된 계정은 덮어쓰거나 잔액을 합산하지 않는다. 이메일·닉네임 일치로 자동 연결하지 않는다.

외부 계정이 첫 로그인하면서 별도 사용자를 생성하기 **전** 연결 흐름을 설계해야 한다. 이미 생성된 계정 간 병합·충돌 정책은 미정이다. Apple/Google 실제 연결 endpoint와 provider 설정은 이번 범위 밖이며 키·계약·UI와 함께 후속 구현한다.

## 배포·운영 분리

`infra/generate.py`는 외부 프레임워크 없이 native CloudFormation JSON을 만든다. `scripts/deploy.py`는 로컬 검증→production dependency만 ZIP→전용 비공개 S3 artifact bucket→환경별 스택 배포를 수행한다. 동일 코드를 dev/staging/prod 별도 스택·Pool·Client·Table·역할·함수로 분리한다. 상용 운영은 별도 AWS 계정과 프로필을 쓰는 것이 권장된다.

```sh
nvm use
npm ci
npm run typecheck
npm test
python3 scripts/deploy.py --environment dev --profile yalla-dev --region ap-south-1
python3 scripts/smoke_dev.py --profile yalla-dev --region ap-south-1
```

스택: `yalla-dev-artifacts`, `yalla-dev-bundle1`. Lambda Node.js 24, DynamoDB on-demand/PITR/암호화, User Pool 삭제 보호, 데이터·인증 Pool·artifact 보존 정책을 사용한다. HTTP stage는 burst 20 / 초당 10의 기술적 기본 제한을 둔다. Lambda·API 로그는 30일 보관하고 요청 본문·인증 헤더·토큰·guestKey는 기록하지 않는다. 함수 URL·IAM 테스트 인증은 제공하지 않는다.

공개 가입 endpoint에는 Guest 자격 생성이 필수이므로 JWT 없이 접근한다. 이미 보호된 게임 데이터 접근은 JWT가 필요하다. 대규모 가입 남용에 대한 device attestation·추가 abuse control, 알람·대응·비용 한도와 운영 수명 정책은 출시 전 운영 설정으로 검토해야 하며, 이 Bundle이 이를 구현했다고 주장하지 않는다. Refresh revoke 이후 access token 즉시 무효화가 필요한 기능은 별도 revocation 검사 설계가 필요하다.

실제 dev 실검증은 Guest 테스트 데이터를 남긴다. 테스트 자격은 메모리에만 존재하며 출력·커밋하지 않는다. 결과와 리소스 식별자는 `06-bundle1-dev-verification.md`에 기록한다.

AWS 근거: [User Pool/Identity Pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-how-to-authenticate.html), [관리자 사용자 생성](https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html), [JWT authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html), [refresh rotation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html), [외부 계정 연결](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html).
