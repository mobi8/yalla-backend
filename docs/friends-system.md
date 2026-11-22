# Friends System

## Unity

`FiftyFiftyScene` connects the existing hamburger controller to Friends. The new menu entry uses an authored menu button as a template, follows the Auto row and displays the incoming request count. The hamburger dot refreshes on entry, periodically and after the Friends list is updated.

The Friends controller creates one modal with individual uGUI and TextMesh Pro elements, a dim layer, safe-area bounds, two tabs and one shared ScrollRect for requests and suggestions. It reuses the game's camel portraits. The scene provides the menu template, portraits and the existing views that block Friends from opening during another modal. The Friends view is constructed at runtime and has no separate serialized prefab.

The FRIEND tab supports code copy, code lookup and confirmation, native invite sharing, inbound actions, outbound cancellation and removal. FRIEND RANK includes the local player and highlights their row. The iOS plug-in presents UIActivityViewController. Tapping a Friends overtake notification queues the FRIEND RANK tab for the intended signed-in recipient. The iOS build postprocessor adds Associated Domains and reuses the main target's configured entitlement file when one exists.

## DynamoDB

Friends uses `PlayerTable` in Mumbai DEV and the existing partition and sort keys. It requires no new table or index.

| PK | SK | Purpose |
| --- | --- | --- |
| `PLAYER#<player>` | `FRIENDS#CODE` | Persistent public code. Created lazily for both new and existing players. |
| `FRIENDS#CODES` | `<public code>` | Unique reverse lookup, claimed in the same transaction as the player code. |
| `FRIENDS#PAIR#<sorted participants>` | `STATE` | Canonical pair, version token, original sender and recipient, status and timestamps. |
| `PLAYER#<participant>` | `FRIENDS#IN#<request UUID>`, `FRIENDS#OUT#<request UUID>` or `FRIENDS#LIST#<request UUID>` | Transactional, paginated views of incoming requests, outgoing requests and accepted relationships. |
| `PLAYER#<sender>` | `FRIENDS#SENT#<operation UUID>` | Send idempotency receipt. The relationship UUID is generated separately by the server. |
| `PLAYER#<invitee>` | `FRIENDS#REFERRAL` | First valid attribution, including inviter, invitee, code, timestamp, status and reward status. |

Conditional DynamoDB writes keep projections and pair state in sync. The API resolves the owner through the existing Cognito Player ID mapping. Recommendations show up to ten real players from the first 50 current-period scores, excluding the caller, pending pairs and accepted friends. New requests start pending. Existing accepted bot relationships remain in friend rankings. A referral is recorded once if the player confirms an invite request within 24 hours of new account creation. Existing migrated players and self-invites are ineligible. The referral record has reward status `NOT_AWARDED`.

## HTTP API

All Friends routes require a Cognito access token. List routes accept optional `limit` (default 20, max 50) and `cursor` parameters. Returned player summaries use a friend code, nickname, avatar and entity type.

| Method and route | Operation |
| --- | --- |
| `GET /friends/code` | Get or allocate my friend code. |
| `GET /friends/search?code=...` | Normalize and look up a code, with caller-relative request status. |
| `POST /friends/requests` | Send using `{code, requestId, referral?}`. Use a fresh client operation UUID for each intentional send and reuse it on retries. |
| `GET /friends/requests/incoming` | List pending incoming requests. |
| `GET /friends/requests/outgoing` | List pending outgoing requests. |
| `POST /friends/actions` | Apply `accept`, `decline`, `cancel` or `remove` using `{code, requestId, action}`. Use the server request UUID from the list. |
| `GET /friends/list` | List accepted friends. |
| `GET /friends/count` | Get the current incoming request count. |
| `GET /friends/suggested` | List eligible players from the current-period ranking. |
| `GET /friends/help` | List accepted human friends with helpable damage on their current Village, including the count of buildings eligible for HELP. Follow `nextCursor` even when a page has no matching entries. |
| `GET /friends/rank` | Get this player's weekly ranking, including every accepted friend. |
| `GET /invites/{code}` | Public lookup, returning only the code and inviter nickname. |

## Village HELP

A damaged building with a positive repair cost can receive HELP once per damage cycle, regardless of the age of the attack. HELP reduces the YP repair cost by 1–30% and costs one Clover. The discount and usage marker stay on the damaged building through subsequent attacks. A completed owner repair clears the marker, and a new attack after that repair starts a new cycle. The list, visit view and HELP command use the current Village damage state. Activity records retain the time the help or thanks occurred.

## Ranking and notifications

The Friends ranking reads the existing period score function, which sums settled distance deltas across all eligible rounds. It applies the DEV weekly window and includes zero-distance members. Friend membership is read from the current relationship projections. Ties are sorted by stable participant ID. Bots have zero distance until the shared ranking source contains a score for the bot.

The DEV Notification Hub observes changes to settled rounds. The router compares cumulative scores immediately before and after the settlement, within the same weekly window. It verifies that the relationship predates the round and still exists for both players, excludes ties and emits `RANK_OVERTAKEN` with Friends scope. The queue carries a stable event ID derived from the period, settling round and recipient. The existing delivery worker enforces a one-hour per-recipient cooldown and per-device delivery deduplication. The stream runs independently of game settlement. DEV APNs remains disabled.

An IAM-authorized direct invocation of `yalla-dev-notification-router` can simulate a bot overtake for a DEV guest with positive weekly distance and an accepted bot relationship. Use `{action:"simulateFriendBotOvertake", recipient, bot, requestId, occurredAt}`. Use the API's settled round timestamp, within the same period and the last hour. The simulator checks actual membership and the recipient's settled distance, then sends a simulated event to the DEV queue. It requires APNs to be disabled and writes no distance data. Existing accepted bot relationships can still be used for this simulation.

## Invite site and cutover

The independent Vercel root is `invite-web/`. It uses game artwork, the real inviter's nickname from the API, a copyable code and instructions to reopen the invite link or enter the code after installation. Set `FRIENDS_API_ORIGIN` to the environment's verified HTTPS API origin. The App Store button appears once `APP_STORE_URL` is set to a verified public listing. The Xcode export identifies the app as `858X3V5QRJ.com.mobi8.yallaball`. That identifier is in the AASA configuration for `/f/*`.

1. Create a separate Vercel project with root `invite-web/`. Deploy to a generated Preview URL and verify the invite response with a real DEV code, invalid-code behavior and the direct AASA JSON response. Configure the verified App Store URL when it is available.
2. Leave `invite.actualab.xyz` on the existing Actualab project until the Preview is verified and a domain reassignment is explicitly approved. Record the current project association and DNS values for rollback.
3. After approval, assign only the invite subdomain to the new project. Verify the HTTPS response, AASA status and content type, an installed-app link from Notes or Messages and the browser fallback on a device without the app. Restore the recorded assignment if these checks fail.

The iOS app accepts the invite on cold or warm launch when Universal Links are configured. The browser fallback cannot carry the code through a new App Store installation. The visitor can reopen the original link or copy the code for manual entry. An App Store installation attribution mechanism is outside this implementation.

## Verification and files

The Mumbai DEV change set deployed successfully. The isolated integration smoke verified code restore, normalized lookup, privacy, opposite-direction requests, decline, cancellation, accepted projections, both players' ranks, removal, bot auto-accept, refreshed weekly distance from a settlement and delivery of a simulated bot event to the notification queue. The backend suite passed 150 tests and the web suite passed three. The web handler and copy feedback were also verified in a local browser. The public invite domain currently returns 404 for the sample route. The UAE and US App Store lookups did not return a listing for this bundle ID.

- Backend implementation in `src/friends.ts`, `src/friends-store.ts`, `src/friend-overtake.ts`, `src/journey-read.ts` and `src/handler.ts`.
- Notification and AWS wiring in `src/notification-events.ts`, `src/notification-router.ts`, `config/dev/notifications.json`, `infra/generate.py` and `infra/bundle1.json`.
- Backend unit and integration tests in `tests/friends.test.ts`. DEV smoke in `scripts/smoke_friends_dev.py`. Web handler, assets, configuration and tests under `invite-web/`.
- Unity view and sharing under `Assets/YallaDrop/Features/Friends/UI/`. Scene and menu wiring in `FiftyFiftyScene.unity` and `OverlayHamburgerMenu.cs`. Notification tap handling is in `Assets/YallaDrop/Core/HyperBase/Notifications/NotificationManager.cs`. Native and signing components in `Assets/Plugins/iOS/YallaFriendInvite.mm` and `Assets/YallaDrop/Editor/YallaFriendsAssociatedDomainsPostBuild.cs`. Deep-link tests in `Assets/YallaDrop/Tests/Editor/FriendsInviteTests.cs`.

```sh
npm run typecheck
npm test
npm --prefix invite-web test
npm run build
python3 scripts/smoke_friends_dev.py
```

Device verification covers compact and notched phone layouts, HUD and Auto/menu interaction, popup focus and scroll, clipboard feedback, the iOS share sheet, cold and warm Universal Links, and CARAVAN and gameplay presentation. Live push verification needs APNs credentials and a registered device.
