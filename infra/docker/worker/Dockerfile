# Temporal Worker — runs @darex/workflows activities + AutonomousAgentWorkflow.
# Build context must be the repo root so pnpm can resolve the workspace.
#
# Build:
#   docker build -f infra/docker/worker/Dockerfile -t darex-worker .
# Run (managed by infra/docker-compose.yml):
#   docker run --rm --net darex-net \
#     -e TEMPORAL_ADDRESS=temporal:7233 -e DB_HOST=postgres \
#     -e ATOMIC_AGENT_URL=http://atomic-agent:8787 darex-worker

# ── deps: install the full workspace graph (frozen lockfile) ────────────────
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN mkdir -p apps/dashboard apps/inbox services/connectors services/workflows packages/shared-types
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/inbox/package.json apps/inbox/package.json
COPY services/connectors/package.json services/connectors/package.json
COPY services/workflows/package.json services/workflows/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN pnpm install --frozen-lockfile

# ── builder: compile connectors + workflows ─────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY packages/shared-types packages/shared-types
RUN pnpm --filter @darex/shared-types build

COPY services/connectors/tsconfig.json services/connectors/tsconfig.json
COPY services/connectors/src services/connectors/src
RUN pnpm --filter @darex/connectors build

COPY services/workflows/tsconfig.json services/workflows/tsconfig.json
COPY services/workflows/src services/workflows/src
RUN pnpm --filter @darex/workflows build

# ── runner: Temporal worker ─────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# No :-dev secret fallbacks in this image. Compose may still supply local
# defaults; production sets DAREX_PROD_FAILFAST=true via the deploy overlay.

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services ./services
COPY infra/docker/prod-failfast.sh /usr/local/bin/darex-prod-failfast
RUN chmod +x /usr/local/bin/darex-prod-failfast

WORKDIR /app/services/workflows
ENTRYPOINT ["/usr/local/bin/darex-prod-failfast"]
CMD ["node", "dist/worker.js"]