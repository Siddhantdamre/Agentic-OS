# Backups + restore drill (I5)

RDS `backup_retention_period` is 7 days on the RDS module (no secrets).

**Local / single-host drill** (do not date in BUILD_STATE.md):

```bash
bash infra/scripts/restore-drill.sh            # dry-run
bash infra/scripts/restore-drill.sh --execute  # throwaway DB, then DROP
```

Log the run in `infra/scripts/restore-drill.md`.

Cloud drill when RDS exists: restore the latest snapshot to a throwaway
instance in the same VPC, confirm `darex_app` connects, then tear down.
Do not add a second database engine. Do not commit snapshot credentials.
