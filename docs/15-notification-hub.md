# DEV Central Notification Hub

## Ranking and channel policy

The DEV player API keeps the seven-day period starting Monday at 00:00 UTC and the Global ranking. Ranking and distance settlement keep their existing JourneyRead keys.

The retired overtake feature has no detector, Activity writer, Push policy, or Router subscription. Historical overtake rows remain stored. The Activity API skips unsupported rows while advancing the cursor, and the CARAVAN view also accepts only settled ATTACK HIT/BLOCKED and RAID STOLEN. Existing Telegram behavior is independent and unchanged.

The Router accepts committed ATTACK and RAID receipts. The Stream mapping filters their existing sort-key prefixes, and application logic applies the result policy. Remote Push remains off. Device registration, delivery history TTL, the shared SQS queue, and DLQ stay available independently of the retired feature.

## DEV deployment

Deploy with `python3 scripts/deploy.py --environment dev --profile yalla-dev --notification-rollout`. This path keeps the existing shared bot and auth artifact key and supplies a separate notification artifact key for Player, Router and Worker. The script aborts on any change to existing bot invoke resources or on any existing deletion or replacement. It leaves the live bot JSON untouched.

After Apple credentials are available, register the private key as SecureString at `/yalla/dev/notifications/apns-private-key`, configure the matching team ID, key ID, Bundle ID and APNs environment, then redeploy the notification configuration. A signed Unity build with the matching entitlement and an actual device are needed to verify APNs delivery. Do not enable remote Push before that configuration is ready.

The removal was deployed in DEV change set `notification-a8d9c12226644f9a`. It modified the Router function/role/mapping, Push Worker, and Player function/integration without replacing or deleting existing resources. The Router no longer reads the ranking index or writes ranking Activity. No existing game or Activity rows were deleted by the rollout.
