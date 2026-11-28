# MyShelter 월드 활성화

## 현재 개발 설정

`world-bundle-v2`에서 World 01~15가 플레이 가능하다. World 08~15의 완료 보상은 World 01~07 및 로컬 상자와 동일한 월드당 100 YP다. 업그레이드 비용, 기존 월드의 보상, 진행 및 보상 영수증은 그대로다. World 16~100은 비활성이다. World 15를 완료하면 보상과 완료 상태가 유지되고 다음 월드 이동은 시작되지 않는다. 다음 콘텐츠를 열 수 있도록 선행 월드 완료 기록은 보존한다.

백엔드가 순서, 선행 완료, 해금 기록과 플레이 가능 상태를 검사한다. 클라이언트 로컬 카탈로그는 같은 `dev` 설정을 바탕으로 생성한다. 서버 모드는 서버가 허용하고 클라이언트에도 검증된 콘텐츠가 있는 월드에 진입할 수 있다. 이후 월드가 등록되어 있어도 플레이 가능 조건을 충족하지 않으면 잠금 상태다.

## 월드 16~30 및 이후 추가

1. Unity 프로젝트의 MyShelter 씬에 배경 1장과 오브젝트별 성장 스프라이트 4장씩을 연결한다. 지도 씬에 월드 순서에 맞는 썸네일을, Raid 씬에 같은 배경을 연결한다. 공통 템플릿을 사용해 World Editor에서 `MyShelterLayout_<world-id>.asset`을 해당 월드 이름으로 저장한다. 템플릿 fallback이나 가려진 지도 이미지는 활성 월드의 필수 리소스를 대신할 수 없다.
2. World 16~100은 이미 등록되어 있다. World 101 이상을 등록할 때는 `world.json`의 새 행에 순번과 `world-101` 같은 ID를 사용하고, 이전 마지막 월드의 `nextWorldId`와 새 월드의 `unlockAfterWorldId`를 연결한다. 새 마지막 월드의 `nextWorldId`는 null이다. `world-rewards.json`에 동일 ID의 보상 행을 추가한다. 이미 사용된 ID와 순번을 보존한다.
3. 두 저장소를 같은 상위 경로에 둔 상태에서 백엔드의 `python3 scripts/extract_world_configs.py`를 실행해 씬의 아트 GUID를 카탈로그와 World/Building 설정으로 가져온다. 이 단계는 보상, 가격, 활성 상태, 버전을 보존한다. 생성 diff의 아트 참조를 검토한다.
4. 승인된 보상을 확정하고 `world-rewards.json`의 `confirmed`를 켠다. 준비된 월드만 `world.json`에서 `enabled: true`, `contentState: READY`로 변경한다. `playable`은 서버가 필수 아트와 보상 설정을 검사해 계산한다. 기존 로컬 정책과 다른 보상은 정책 합의와 양쪽 보상 처리 검증이 필요하다.
5. 세계 설정 파일 세 개의 공통 `releaseId`와 각 파일 `version`을 올린다. `python3 scripts/sync_world_playability.py`로 Unity의 `MyShelterWorldAvailability.json`을 갱신한다. `--check`는 파일을 쓰지 않고 두 저장소의 일치와 Sprite 및 Layout GUID, 지도 및 Attack/Raid 연결을 검사한다. `npm run typecheck`와 `npm test`를 수행한다.

## 추후 dev 적용

배포 세트는 백엔드 코드, Unity 클라이언트의 생성된 카탈로그 및 리소스, 다음 S3 설정 세 개다.

- `config/dev/world.json` → `game-config/dev/v1/world.json`
- `config/dev/world-buildings.json` → `game-config/dev/v1/world-buildings.json`
- `config/dev/world-rewards.json` → `game-config/dev/v1/world-rewards.json`

별도 배포 시 먼저 백엔드 변경과 클라이언트 리소스를 준비한다. 기존 S3 객체의 ETag와 버전을 확보하고, 기존 배포 절차에서 생성한 백엔드 검증 코드와 `scripts/publish_game_config.py --name <name> --profile <dev-profile> --replace-etag <etag>`를 사용한다. 게시 도구는 로컬 리소스 검증을 먼저 수행한다. 세 파일은 하나의 배포 세트로 교체한다. 개별 S3 키 교체 중에는 releaseId 불일치로 월드 API가 잠시 거부될 수 있으므로 dev 검수 시간을 잡고, 캐시 TTL 60초가 지난 뒤 `/worlds/state`가 기대한 releaseId와 플레이 가능 목록을 반환하는지 확인한다. 복구가 필요하면 세 파일을 동일한 이전 releaseId로 함께 되돌리고, 이미 진입한 유저가 사용하는 월드 ID를 보존한다.

## 실제 게임 검수

- 신규 World 07 완료와 이미 완료한 World 07 저장본에서 각각 08 진입을 확인한다. 100 YP가 한 번만 지급되고 World 08 건물은 모두 레벨 1이어야 한다.
- World 08~15에서 완료 상자, 보상 팝업, 지도, 캐러밴, Dust 전환을 확인한다. World 15 완료 후에는 World 16 진입이 없어야 한다. 로컬 모드에서도 같은 진행 경계를 확인한다.
- World 08과 15에서 친구 방문, Attack/Raid 배경과 타깃, 피해 건물 수리 및 복구를 확인한다. 보상 또는 이동 도중 재접속해 누적 진행과 보상 영수증을 검증한다.
