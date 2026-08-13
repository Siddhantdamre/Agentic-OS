# Darex deploy (single server)

This folder ships the stack onto **one Docker host**. It is not Terraform,
not multi-AZ, and not production-hardened beyond loopback binds + a reverse
proxy. Those are still future-scope Phase 8.

## Local test (laptop)

From the repo root, not this folder:

```bash
./start.sh           # compose + migrate + probes
./start.sh --dev     # infra, then host Next.js
./start.sh --down
```

## Server

1. Provision Ubuntu (or similar) with Docker Compose V2 and Node 20+.
2. Clone or rsync the repo to `/opt/darex`.
3. Copy env and fill **real** secrets (never commit them):

```bash
cp deploy/env.production.example .env
# edit .env — https URL, UUID Nango key, no changeme, ALLOW_DEMO_AUTH=false
```

4. Deploy:

```bash
# on the server
./deploy/deploy.sh

# or from your laptop
DEPLOY_HOST=ubuntu@YOUR.IP DEPLOY_PATH=/opt/darex ./deploy/deploy.sh
```

Laptop mode does **not** overwrite `.env` on the server.

5. TLS: install Caddy, use `Caddyfile.example`, point DNS at the box.
   Meta WhatsApp webhooks must reach `https://your.domain/api/webhooks/whatsapp`.

6. In Nango (SSH tunnel to `:3003`) paste real OAuth client IDs. Rotate the
   Meta token. Set `JINA_API_KEY` if you want web search.

## What this overlay changes

`docker-compose.prod.yml` keeps the same 19 services as
`infra/docker-compose.yml` but binds Postgres, Redis, Temporal, Langfuse,
LiteLLM, Nango, inbox, and the dashboard to **127.0.0.1**. Only Caddy (or
another host proxy) should be public.

## Commands

| Command | What |
|---------|------|
| `./deploy/deploy.sh` | build, up, migrate, wait for `/api/health` |
| `./deploy/deploy.sh --no-build` | up without rebuilding images |
| `./deploy/deploy.sh --status` | `compose ps` + health |
| `./deploy/deploy.sh --down` | stop, keep volumes |
