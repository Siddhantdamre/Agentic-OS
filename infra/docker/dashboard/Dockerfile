# Dashboard — Next.js app server (full monorepo workspace build).
# Build context must be the repo root so pnpm can resolve the workspace.
#
# Build:
#   docker build -f infra/docker/dashboard/Dockerfile -t darex-dashboard .
# Run (managed by infra/docker-compose.yml):
#   docker run --rm -p 3000:3000 --net darex-net \
#     -e DB_HOST=postgres -e SUPERTOKENS_CONNECTION_URI=http://supertokens:3567 \
#     -e TRUEFORGE_URL=http://trueforge:8790 darex-dashboard

# ── deps: install the full workspace graph (frozen lockfile) ────────────────
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN mkdir -p apps/dashboard apps/inbox services/connectors services/workflows packages/shared-types packages/whatsapp-gateway
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/inbox/package.json apps/inbox/package.json
COPY services/connectors/package.json services/connectors/package.json
COPY services/workflows/package.json services/workflows/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/whatsapp-gateway/package.json packages/whatsapp-gateway/package.json
# Download cache survives rebuilds, so a dependency change re-downloads only what changed.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

# ── builder: compile workspace deps, then run `next build` ─────────────────
FROM deps AS builder
WORKDIR /app

COPY packages/shared-types packages/shared-types
RUN pnpm --filter @darex/shared-types build

COPY packages/whatsapp-gateway packages/whatsapp-gateway
RUN pnpm --filter @darex/whatsapp-gateway build

COPY services/connectors/tsconfig.json services/connectors/tsconfig.json
COPY services/connectors/src services/connectors/src
RUN pnpm --filter @darex/connectors build

COPY services/workflows/tsconfig.json services/workflows/tsconfig.json
# The package build is `tsc && node scripts/copy-assets.js`; without this the build stage cannot find the script.
COPY services/workflows/scripts services/workflows/scripts
COPY services/workflows/src services/workflows/src
RUN pnpm --filter @darex/workflows build

ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/dashboard apps/dashboard
# .dockerignore excludes .env.local (never leak dev secrets into the image),
# but `next build` stats it unconditionally and ENOENTs instead of treating
# a missing file as "no local overrides". An empty placeholder satisfies it.
RUN touch apps/dashboard/.env.local
# next build imports the DB pool while collecting pages. This value exists
# only in the builder stage. The runner image does not inherit it; compose
# supplies the real password at container start.
ENV DB_PASSWORD=build-only-not-a-runtime-secret \
    APP_DB_PASSWORD=build-only-not-a-runtime-secret
# Type-check and lint run in CI and the pre-push hook; skipping them here saves 5+ minutes on a small box.
ENV SKIP_NEXT_CHECKS=1
# The Next build cache survives rebuilds (a mount is not part of the image), so a code-only
# change recompiles just what changed instead of the whole app.
RUN --mount=type=cache,id=next-cache,target=/app/apps/dashboard/.next/cache \
    pnpm --filter @darex/dashboard build

# Slim the runtime tree: drop the .next build cache and the native binaries this image never
# loads (musl builds on a glibc/Debian base, and the turbo CLI used only for monorepo builds).
RUN rm -rf apps/dashboard/.next/cache node_modules/.pnpm/*linux-*-musl* node_modules/.pnpm/@turbo+*

# ── runner: production `next start` with workspace dist available ──────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# No :-dev secret fallbacks in this image. Compose may still supply local
# defaults; production sets DAREX_PROD_FAILFAST=true via the deploy overlay.

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services ./services
COPY --from=builder /app/apps/dashboard ./apps/dashboard
COPY infra/docker/prod-failfast.sh /usr/local/bin/darex-prod-failfast
RUN chmod +x /usr/local/bin/darex-prod-failfast

WORKDIR /app/apps/dashboard
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/darex-prod-failfast"]
CMD ["node_modules/.bin/next", "start", "-p", "3000"]