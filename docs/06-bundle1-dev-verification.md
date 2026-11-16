# Bundle 1 dev 배포·검증 결과

이 문서는 초기 지급량 변경 전 배포의 역사적 검증 기록이다. 현재 신규 Guest 지급량은 Energy 50 / Diamond 0 / YallaPoint 0이며, 변경 후 검증은 [07 문서](07-starter-grant-update.md)를 참조한다.

검증일: 2026-11-16 (Asia/Dubai). AWS Profile `yalla-dev`, Region `ap-south-1`, Account `533266967583`.

## 배포 결과

- CloudFormation: `yalla-dev-artifacts`, `yalla-dev-bundle1` 생성·업데이트 성공.
- API: https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com
- Cognito User Pool: `ap-south-1_4qox6fzBy`
- Cognito public app client: `19mib45cmg07j8bfjs407htbv9` (client secret 없음)
- DynamoDB: `yalla-dev-bundle1-PlayerTable-1TPG03GJPKOHQ`
- Lambda: `yalla-dev-auth`, `yalla-dev-player`, Node.js 24 / arm64.
- dev/staging/prod 배포 매개변수로 리소스와 데이터를 분리한다. 운영 환경에는 배포하지 않았다.

## 로컬 결과

Node.js 24.22.3으로 실행:

- `npm run typecheck`: 통과
- `npm test`: 2개 파일, **38개 테스트 통과**
- `npm run build`: 통과
- `git diff --check`: 통과

검증 범위: Unity 초기값, C# decimal/long 범위·정밀도·DynamoDB exponent 복원, 손상 상태 거부, 동시 생성, 응답 유실·미확정 timeout 복구, Cognito 가입 중단·토큰 갱신, JWT issuer/client/token-use/만료·소유권 검증, 초기 지급 원자성·비클라이언트 잔액 변경.

## 실제 AWS API 검증

`python3 scripts/smoke_dev.py --profile yalla-dev --region ap-south-1`: **27개 검증 통과**.

1. 실제 Guest 생성 및 Energy 200 / Diamond 20000 / YallaPoint 0 확인
2. 같은 비밀 자격 재접속 시 Player·Wallet 전체 동일
3. Profile 인증 조회
4. Progress 인증 조회
5. Wallet 인증 조회
6. Save 인증 조회
7. Save 트랜잭션 복원 결과 일치
8. 인증 토큰 누락 거부
9. 잘못된 JWT 거부
10. ID token을 API access token으로 사용하는 요청 거부
11. 클라이언트 잔액·Player ID 주입 거부
12. Wallet 쓰기 경로 없음 확인
13. 동시 provisioning 재시도에서 중복 지급 없음
14. Refresh token 회전 확인
15. 새 access token으로 같은 Player·Wallet 복원
16. 잘못된 refresh token 거부
17. 중단된 Cognito 계정에 대한 동시 복구에서 신규 지급 한 번만 수행
18. Cognito 사용자만 생성된 미완료 단계에서 정상 복구
19. 다른 Guest 토큰으로 자기 데이터만 조회
20. 임의 Player ID 조회 경로 없음 확인
21. 영수증·원인 표식 각각 한 개, Wallet version 1 유지
22. 인증 연결의 소유 Player 및 schema/version 메타데이터 확인
23. 기존 인증 연결과 충돌하는 DynamoDB 트랜잭션 거부
24. 실패한 트랜잭션의 후보 Player가 저장되지 않음 확인
25. Refresh token revoke 성공
26. 취소된 refresh token 갱신 거부
27. Guest 비밀 자격 재인증 후 같은 Player·Wallet 유지

최종 성공 실행의 테스트 Player ID:

- `19fe871a-3f1e-4506-b2a8-89edb9223c11`
- `a8019ac7-efd8-4ba9-9912-cb2a28b5d7e2`

시험 과정에서 생성한 Guest 계정과 게임 데이터는 dev에 남아 있다. 비밀 Guest 키·password·access/id/refresh token은 결과물·로그·Git에 기록하지 않았다. 실패 후 재실행에서 생성된 이전 테스트 계정도 자동 삭제하지 않았다.

실환경에서 발견한 Cognito sub의 RFC UUID variant 차이를 수정하여 불투명 식별자로 취급한다. 해당 회귀 테스트를 로컬에 추가하고 수정 배포본으로 위 검증을 완료했다.

## 구현 파일

- `src/model.ts`: Player / Progress / Wallet 스키마, 기존 Unity 초기값, 정밀도 검증
- `src/auth.ts`: 실제 Cognito Guest 발급·재접속·refresh rotation·revoke
- `src/starter.ts`: 초기 지급 Wallet·불변 영수증·중복 방지 원인 표식
- `src/repository.ts`: 강한 일관성 인증 연결 조회, 원자적 생성, 트랜잭션 snapshot 복원
- `src/service.ts`: 인증 subject별 멱등 생성·응답 유실 복구
- `src/handler.ts`: API 처리, JWT 문맥·소유권 검사, 안전한 오류 응답
- `tests/player.test.ts`, `tests/auth.test.ts`: 38개 로컬 테스트
- `infra/generate.py`, `infra/artifacts.json`, `infra/bundle1.json`: native CloudFormation
- `scripts/deploy.py`, `scripts/smoke_dev.py`: 재현 가능한 명시적 배포·실 API 검증
- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`: 기존 도구 활용 및 Cognito AWS SDK 추가
- `README.md`, `.gitignore`, `docs/05-bundle1-implementation.md`, 본 문서: 실행·연동·검증 설명

01~04 설계 문서와 기존 `.nvmrc`는 변경하지 않았다. Unity 소스도 수정하지 않았다. Unity 연동은 [05 구현·연동 계약](05-bundle1-implementation.md)을 따른다.

## 남은 범위와 제약

Unity는 아직 서버 API를 호출하지 않는다. CSPRNG Guest 키의 안전한 저장, 최초 Guest 생성, access token 전송, refresh 직렬화, 비동기 Save 복원·decimal 문자열 변환, 서버 version 기반 UI 갱신을 추후 Unity 변경으로 적용해야 한다. 로컬 Load/seed/reset의 잔액을 서버에 재지급하거나 전체 Save로 덮어쓰면 안 된다.

Apple/Google은 기존 native Cognito 사용자와 Player ID에 연결할 수 있도록 경계를 마련했다. 실제 소셜 provider 설정·계정 연결·계정 간 충돌 처리·기존 save import는 구현하지 않았다. 이들 미정 정책을 임의로 확정하지 않았다.

Logout은 refresh 자격 취소이며 이미 발급된 access JWT를 즉시 무효화하지 않는다. 자격 분실·재설치 복구 범위 및 상용 출시 전 abuse 대응·운영 알람 정책은 [05 문서](05-bundle1-implementation.md)의 한계를 확인해야 한다. 게임 결과 정산, Session/Pending Drop, Raid, Collection/Inventory, 결제·광고 보상은 이번 배포에 포함하지 않는다.
