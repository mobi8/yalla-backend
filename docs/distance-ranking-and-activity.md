# Distance Ranking and Activity

Both routes use the existing Cognito access token. List endpoints accept a page size of 1–50 (default 20) and an opaque `cursor`. A cursor belongs to its board or owner. Refresh the list if a current-period cursor expires at rollover.

| Route | Response |
|---|---|
| `GET /ranking/distance?scope=total` | Distances, server nicknames, avatar IDs, ranks, participant count, caller's rank and distance, current period distance, and `nextCursor`. |
| `GET /ranking/distance?scope=period` | The same ranking for the current UTC period. Provide `periodStart` in ISO 8601 at an exact boundary to query a retained period. A player with no qualifying round is unranked for that period. |
| `GET /players/me/activity` | Caller-only settled ATTACK HIT/BLOCKED and RAID STOLEN, with Event ID, timestamp, participants and known settlement details. |

The sparse `JourneyRead` GSI indexes the existing authoritative items. The total board uses `PROGRESS.distance` and reads `PROFILE.nickname` when serving a page. Ties are ordered by descending player UUID. Only player partitions with a positive distance for the selected board participate. Zero-distance players are unranked and excluded from counts and pages. Bots do not have player progress records. Period distance is the sum of `reward.distance` from immutable SETTLED rounds in the requested window. A retried result uses the same round item and therefore the same index entry. Index metadata lives on the source items and commits in the same transaction as settlement.

CloudFormation `RankingPeriodDays` sets `RANKING_PERIOD_DAYS` on the Lambda. DEV uses `1`. Periods begin at UTC midnight, with seven-day windows anchored to Monday UTC. Boundaries are inclusive at the start and exclusive at the end. Change the parameter to `7` to aggregate from the same confirmed history. Existing day records remain available as source data. No additional TTL or deletion policy is applied to rounds or activity receipts.

The period query reads only the indexed settled rounds in the requested window and reuses a five-second in-process result. Total pages seek by distance and UUID, and count indexed entries for exact rank at read time. Activity pages seek by timestamp and Event ID in the owner's GSI partition. GSI propagation is eventually consistent. The DEV backfill fills missing index metadata on existing items, is safe to repeat, and excludes the documented isolated rollout receipts. Tagged smoke events and wallet RAID MISS are not indexed.

A future notification worker can consume committed receipt stream events, deduplicate by Event ID and resolve the owning player's opted-in device endpoints. Device registration, consent, delivery retries and push credentials are outside these read APIs.
