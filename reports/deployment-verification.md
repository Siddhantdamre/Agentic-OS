# Deployment verification — Agentic-OS release candidate

Commit: `51cc68a0bbcfcccf80af9330d50abe7c1aee46b8` + uncommitted changes (see release-readiness.md). Date: 2026-10-17.

## Image-build failure (CI run 38925975439): root cause and fix
- Error in CI for dashboard and worker images: `Cannot find module '/app/services/workflows/scripts/copy-assets.js'`.
- Cause: `services/workflows/package.json` builds with `tsc && node scripts/copy-assets.js`, but both builder stages copy only `services/workflows/tsconfig.json` and `services/workflows/src`. The `scripts/` folder is never copied into the image build context stage.
- Fix: one added line in each of `infra/docker/dashboard/Dockerfile` and `infra/docker/worker/Dockerfile`: `COPY services/workflows/scripts services/workflows/scripts`. The asset-copy step is kept; no check was weakened.
- Evidence of the failure and the fix (**proxy, not an image build**): a temp directory holding exactly the files the old builder stage had reproduces the exact error; the same directory plus `scripts/` runs the script and produces `dist/metrics/core-kpis.yaml`.
- **Real image build: BLOCKED (ENVIRONMENT ISSUE).** The sandbox has the Docker CLI (v29.3.1) but no Docker daemon (`/var/run/docker.sock` missing), so neither image could be built or booted here. The mission's steps "build both images from a clean context, inspect assets, boot the images, signed-in smoke test against them" are therefore **NOT DONE**. Run on any machine with Docker:
  ```
  docker build -f infra/docker/worker/Dockerfile -t darex-worker:rc .
  docker build -f infra/docker/dashboard/Dockerfile -t darex-dashboard:rc .
  docker run --rm --entrypoint sh darex-worker:rc -c 'ls services/workflows/dist/metrics/core-kpis.yaml'
  ```
  or simply push the fix and read the GitHub "images" workflow.
- Other things that make a green image workflow likely but unproven: workspace build (`pnpm build`) passes (6/6 tasks), type checks pass.

## Release boundary checks
| Check | Result |
|---|---|
| Fresh DB: 119 migrations in order, re-run is a no-op | PASS |
| Production fail-closed script refuses demo auth, superuser DB role, missing/all-zero channel key, dev DB passwords | PASS (7 cases run) |
| Prod overlay sets `DAREX_PROD_FAILFAST=true`, `DB_USER=darex_app`, `ALLOW_DEMO_AUTH=false` on dashboard, worker, mcp-bridge | PASS (source) |
| Readiness endpoint `/api/health/ready` checks dependencies (db, probes with timeouts) rather than only process liveness | PASS (source); not exercised against a failing dependency |
| Worker, Temporal, model gateway available | NOT TESTED: no Temporal server or model gateway in the sandbox; background-check heartbeat interceptor still unverified inside a real worker |
| Connector status truthful | PASS in harness (F11: revoked connection reported honestly, no call with a dead token) |
| Backup / restore / rollback | NOT TESTED. No restore drill was run here. |
| Dependabot PRs #3/#4 (22 + 14 updates incl. TypeScript 5.9→7, ESLint 8→10) | NOT MERGED, as instructed |
| Branch protection on `main` | Reported unprotected; not changed (needs the owner) |

## Concern to check before launch
- The dashboard bundles the workflows code at build time. Any worker-side fix needs a dashboard rebuild/redeploy as well as a worker redeploy.
