# Backup restore drill (I5)

Do **not** date this drill in `BUILD_STATE.md`. Append a row here after each
run (dry-run or `--execute`).

## How

```bash
# from repo root, compose postgres must be up
bash infra/scripts/restore-drill.sh            # dry-run (default)
bash infra/scripts/restore-drill.sh --execute  # restore into darex_restore_drill, then DROP
```

The dump is taken from `darex-postgres` as superuser `darex`. Runtime check
uses `darex_app`. The throwaway database is never left behind on success.
Do not commit dump files. Do not replace Postgres.

RDS automated backups (7-day retention) live in `infra/terraform/modules/rds`.
A cloud restore drill still follows the same proof: `darex_app` can connect
and the throwaway instance is torn down.

## Log

| Date (UTC) | Mode | Result | Operator |
|------------|------|--------|----------|
| 2026-08-13 | script landed | not yet run against this machine | WS-23 |
| 2026-08-23 | `--execute` | pass — 190,356-byte schema restored into `darex_restore_drill`, `darex_app` connected, throwaway dropped. Covers migrations 001–029, so the new `orgs` policy and the 43 rewritten policies restore intact. | local |
