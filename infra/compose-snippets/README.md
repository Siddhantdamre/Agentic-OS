# Compose snippets (merge convention)

This directory is how **other workstreams** add Compose services, volumes,
networks, or env without forking a second kernel.

The kernel is `infra/docker-compose.yml` (**20 services**, including
PgBouncer). WS-23 owns that file and **merges** approved snippets into it.

## Merged into the kernel (do not re-add)

| Snippet | What landed in the kernel |
|---------|---------------------------|
| WS-02.yml | `DB_USER`/`DB_PASSWORD` as `darex_app` on dashboard, worker, **atomic-bridge** |
| WS-12.yml | Langfuse Redis keepalive/maxmemory; ClickHouse ulimits; ingest queue delay + write batch |
| WS-11.yml | Dashboard `REDIS_URL=redis://redis:6379` + `depends_on` Nango `redis` (SSE bus; never langfuse-redis) |
| WS-04.yml | Worker (and dashboard enqueue) `EMBEDDING_MODEL` / `EMBEDDING_DIM` / `LITELLM_*` on existing worker — no new broker. Unset model fails the **worker**, not the webhook path. |

**WS-12 / langfuse-redis is Langfuse-only.** The dashboard SSE bus (I3 / WS-11)
must use the Nango `redis` service (or a dedicated bus Redis). Never point
`REDIS_URL` / realtime-hub at `langfuse-redis`.

After a snippet is merged it is **deleted** so `compose-cmd.sh` does not
apply the same overlay twice. Drop a new `WS-XX.yml` here for the next pass.

## How to add something

1. Create `infra/compose-snippets/WS-XX.yml` (or `WS-XX.yaml`).
   Name it after the workstream id (`WS-12.yml`, `WS-I3.yml`, …).
2. Put **only additive overlays**: extra services, extra env on an existing
   service, extra volumes. Never copy the whole kernel. Never replace
   Postgres. Never add Mem0, LangGraph, or a second MCP server.
3. Keep local `${VAR:-dev}` defaults out of **image CMD**; they may stay in
   the snippet the same way the kernel compose file does.
4. WS-23 inlines the snippet into `infra/docker-compose.yml` and then
   **deletes** the snippet (or you delete it once merged) so services are
   not defined twice.

`infra/scripts/compose-cmd.sh` always loads the kernel first, then every
`*.yml` / `*.yaml` here (sorted), then any `--overlay` (prod). That means a
snippet works **before** it is merged. After merge, remove the snippet so
Compose does not see a duplicate service definition.

## File shape

```yaml
# infra/compose-snippets/WS-12.yml
# Workstream: WS-12. Additive overlay. Kernel stays 19 services until merged.
services:
  embed-worker:
    # ...
    networks:
      - darex-net
```

Reuse the existing `darex-net` network. Do not declare a second external
network unless WS-23 has already added it to the kernel.

## What not to put here

| Topic | Wave | Where |
|-------|------|--------|
| PgBouncer in front of Postgres | 3 (I4) | kernel `pgbouncer` service (session pool) |
| Backup restore drill | 3 (I5) | `infra/scripts/restore-drill.sh` + `restore-drill.md` |
| Alerting scripts | 3 (I6) | `infra/scripts/alerting-*.js` |
| Split ingest host (Traefik/Caddy) | later (I7) | `infra/scripts/split-ingest.md` + Caddyfile comments |

## Boot

```bash
pnpm infra:up                          # kernel + unmerged snippets
./start.sh                             # same via compose-cmd.sh
./deploy/deploy.sh                     # kernel + snippets + prod overlay
```

Phase 0 (`infra/scripts/check-phase0.js`) must stay green. New kernel
services only get a phase-0 check when WS-23 adds them **and** they are
foundation infra (not dashboard/worker/agent).
