# Darex deploy (single server)

This folder ships the stack onto **one Docker host**. Wave 1 hardens that
path (loopback binds, Caddy HTTPS, `darex_app`, no demo auth). Terraform
(VPC/RDS/Redis/secrets/HTTPS) lives in `infra/terraform/` as a **starter**
— it is not this overlay and is not required to boot the 19-service
compose kernel.

## Local test (laptop)

From the repo root, not this folder:

```bash
./start.sh           # compose + migrate + probes
./start.sh --dev     # infra, then host Next.js
./start.sh --down
```

`pnpm infra:up` and `./start.sh` load `infra/docker-compose.yml` first,
then any unmerged `infra/compose-snippets/WS-XX.yml` (see that directory's
README). WS-23 merges snippets into the kernel; do not add a second
compose file at repo root.

## Server: the short way

On a fresh Ubuntu box with Docker and git, DNS for your domain already pointing at it:

```bash
git clone https://github.com/DarexAI-AI-Startup/Agentic-Os-SaaS.git /opt/darex && cd /opt/darex
FRONTEND_REPO_URL=https://<token>@github.com/DarexAI-AI-Startup/agentic-os-frontend.git ./deploy/deploy.sh
```

It asks for the domain and your OpenRouter key, writes `.env` with generated secrets, installs
Caddy for HTTPS, pulls the newest backend and frontend, builds, migrates, health-checks, and
prints the live link plus the deployed commits. Re-running it later redeploys the latest code
and never touches `.env`. Pass `DOMAIN` and `OPENROUTER_API_KEY` as env vars to skip the prompts,
or `--no-proxy` to skip Caddy. The manual steps below are the same thing done by hand.

## Quick redeploy after a push

```bash
./deploy/redeploy.sh          # pull backend + frontend, rebuild only what changed, restart the frontend
./deploy/redeploy.sh --plan   # show what it would rebuild, change nothing
```

It diffs against the commits saved after the last successful run (`.git/darex-deployed`), so a
run that failed halfway is retried in full. Docs-only pushes rebuild nothing; a new frontend
commit rebuilds just the frontend; dashboard or shared-package changes rebuild the dashboard,
the worker and the MCP bridge. The frontend is restarted on every run. Use `--all` to force a
full rebuild, or name services (`./deploy/redeploy.sh inbox`). Data and `.env` are never touched.
Use `deploy.sh` for the first install or when the proxy, `.env` secrets or ports change.

## Server (manual steps)

1. Provision Ubuntu (or similar) with Docker Compose V2 and Node 20+.
2. Clone or rsync the repo to `/opt/darex`.
3. Copy env and fill **real** secrets (never commit them):

```bash
cp deploy/env.production.example .env
# edit .env — https URL, UUID Nango key, no changeme
# required: DB_USER=darex_app  ALLOW_DEMO_AUTH=false
```

`deploy/deploy.sh` **fail-fasts** if `DB_USER` is not `darex_app` or
`ALLOW_DEMO_AUTH` is not `false`. Migrations still connect as superuser
`darex`; runtime containers use `darex_app`.

It also refuses to start without the WhatsApp secrets: `CHANNEL_SECRETS_KEY`
(64 hex characters, `openssl rand -hex 32`, seals stored Meta tokens; back it
up with the database), `EVOLUTION_API_KEY` and `EVOLUTION_WEBHOOK_SECRET`
(long random strings, not the dev defaults). By default it deploys `main`;
set `DEPLOY_BRANCH` for another branch. Migrations run after the containers
come up, so new code briefly sees the old schema instead of old code seeing
the new one for the whole image build.

4. Deploy:

```bash
# on the server
./deploy/deploy.sh

# or from your laptop
DEPLOY_HOST=ubuntu@YOUR.IP DEPLOY_PATH=/opt/darex ./deploy/deploy.sh
```

Laptop mode does **not** overwrite `.env` on the server.

Compose file order (later wins):

1. `infra/docker-compose.yml` (19-service kernel)
2. `infra/compose-snippets/*.yml` (unmerged WS overlays)
3. `deploy/docker-compose.prod.yml` (loopback binds + prod fail-fast)

5. TLS: install Caddy, use `Caddyfile.example`, point DNS at the box.
   Meta WhatsApp webhooks must reach `https://your.domain/api/webhooks/whatsapp`.
   Split ingest (I7) is documented in `infra/scripts/split-ingest.md`.
   Uncomment the ingest site in `Caddyfile.example` only when a dedicated
   ingest process exists.

6. In Nango (SSH tunnel to `:13003`) paste real OAuth client IDs. Rotate the
   Meta token. Set `JINA_API_KEY` if you want web search.

## The frontend (NEW-FRONTEND)

The site users open is `NEW-FRONTEND` (its own repo, `agentic-os-frontend`), served by the
`frontend` container on `127.0.0.1:13100`. It proxies `/api/*` to the dashboard, so point
Caddy/nginx at **3100**, not 3000. `NEXT_PUBLIC_APP_URL` stays your public https URL, and
Google/Nango redirect URIs are `https://<your-domain>/api/auth/oauth/callback/<provider>`.

Each `./deploy/deploy.sh` run clones or fast-forwards `NEW-FRONTEND` to the newest
`FRONTEND_BRANCH` (default `feat/new-frontend`) and rebuilds the image, so a deploy always
carries the latest frontend commit. For a private repo set `FRONTEND_REPO_URL` (token or SSH
URL). From a laptop (`DEPLOY_HOST`), the local `NEW-FRONTEND` folder is rsynced instead.

## What this overlay changes

`docker-compose.prod.yml` keeps the same services as
`infra/docker-compose.yml` (20 including PgBouncer) but binds Postgres,
PgBouncer, Redis, Temporal, Langfuse, LiteLLM, Nango, inbox, and the
dashboard to **127.0.0.1**. Only Caddy (or another host proxy) should be public.

It also sets `ALLOW_DEMO_AUTH=false`, `DB_USER=darex_app`, and
`DAREX_PROD_FAILFAST=true` on dashboard / worker / atomic-bridge so shipped
images refuse known dev secret defaults. Local compose does **not** set
that flag, so laptop `${VAR:-dev}` defaults still work.

## Terraform (optional, not this host)

`infra/terraform/` is the AWS starter (VPC, RDS, Redis, Secrets Manager,
ALB+ACM). Secrets go in uncommitted `terraform.tfvars`. Local PgBouncer is
`darex-pgbouncer` (session pool). Restore drill: `bash infra/scripts/restore-drill.sh`.
Alerting: `node infra/scripts/alerting-run.js`. Applying Terraform is **not**
required for this single-host Caddy path.

## Commands

| Command | What |
|---------|------|
| `./deploy/deploy.sh` | build, up, migrate, wait for `/api/health` |
| `./deploy/deploy.sh --no-build` | up without rebuilding images |
| `./deploy/deploy.sh --status` | `compose ps` + health |
| `./deploy/deploy.sh --down` | stop, keep volumes |
| `bash infra/scripts/restore-drill.sh` | backup restore drill (dry-run) |
| `node infra/scripts/alerting-run.js` | I6 probes (fail closed) |
