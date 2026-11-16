# 신규 Guest 초기 지급량 변경

적용·검증일: 2026-11-16 (Asia/Dubai).

## 변경 범위

- 신규 Guest만 Energy **50**, Diamond **0**, YallaPoint **0**으로 생성한다.
- `src/model.ts`의 신규 Wallet 초기값과 `src/starter.ts`의 초기 지급 검증만 변경했다. 인증·소유권·조건부 트랜잭션·원인 키·API 응답 구조는 유지한다.
- 요청에 따라 영수증 `configVersion=starter-v1` 및 item `schemaVersion/version`을 유지한다. 실제 지급액은 `deltas`, `balancesBefore/After`에 남고, `requestHash`도 실제 지급량을 포함한다.
- Diamond 필드는 저장·응답에 그대로 포함하며 현재 사용하지 않는다. Energy 자연 충전 상한 50과 초과 보유 허용 원칙은 변경하지 않는다. 자연 충전 명령 구현은 여전히 후속 범위다.
- 기존 Wallet·Player·영수증을 수정·회수·재지급하는 migration이나 관리 명령은 실행하지 않았다. 사용자 지시에 따라 추가 기존 데이터 스냅샷·비교는 생략했다.
- Unity 소스와 인프라 정의는 변경하지 않았다. 변경된 Lambda 코드만 기존 dev 배포 절차로 반영했다.

## 로컬 검증

Node.js 24.22.3에서 typecheck·build 통과, Vitest **39개 테스트 통과**.

기존 인증·조회·멱등성 테스트를 유지하면서 초기값·영수증 기대값을 수정했다. 기존 Energy 200 / Diamond 20000 Wallet의 재접속·조회가 신규 초기화 함수를 호출하거나 기존 잔액을 덮어쓰지 않는 회귀 테스트를 추가했다. 이 기존 Wallet 검증은 로컬 fixture만 사용한다.

## AWS dev 검증

Profile `yalla-dev`, Region `ap-south-1`, CloudFormation `yalla-dev-bundle1` 업데이트 성공. 배포 저장소 스택과 인프라 정의는 변경 없음.

API: https://eok1jy0sq4.execute-api.ap-south-1.amazonaws.com

**신규 Guest 한 명만 생성**하여 17개 실검증을 통과했다.

- Player ID: `bca093df-c296-4f07-934f-12de7e2417e4`
- Wallet: Energy 50 / Diamond 0 / YallaPoint 0, version 1, recharge anchor 0
- Profile·Progress·Wallet·Save 인증 조회 정상
- 동일 Guest 재접속과 인증된 생성 재시도에서 같은 Player·Wallet 복원, 추가 지급 없음
- 누락 토큰·잘못된 JWT·ID token의 API 사용 거부
- Refresh 후 동일 Wallet 복원 정상
- 해당 신규 Player의 PROFILE·PROGRESS·WALLET·영수증·원인 표식 각 한 개 확인
- 영수증 버전 `starter-v1` 유지, `deltas`와 `balancesAfter`에 50/0/0 기록
- 재접속 후에도 Wallet version 1 유지

실검증에서는 이 신규 Guest 항목만 조회했으며 기존 Guest 데이터 비교·수정은 수행하지 않았다. Guest 비밀 키와 JWT·refresh token은 메모리에서만 사용하고 문서·로그·Git에 기록하지 않았다. 전체 다중 Guest smoke 테스트는 이번 실검증에서 실행하지 않았고, 스크립트의 신규 기대값만 갱신했다.
