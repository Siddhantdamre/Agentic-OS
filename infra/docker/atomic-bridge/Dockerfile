FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable pnpm

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @darex/shared-types build
RUN pnpm --filter @darex/workflows build

FROM node:20-slim AS runner
WORKDIR /app
RUN corepack enable pnpm

ENV NODE_ENV=production
# No :-dev secret fallbacks in this image. Compose may still supply local
# defaults; production sets DAREX_PROD_FAILFAST=true via the deploy overlay.

COPY --from=builder /app ./
COPY infra/docker/prod-failfast.sh /usr/local/bin/darex-prod-failfast
RUN chmod +x /usr/local/bin/darex-prod-failfast

ENTRYPOINT ["/usr/local/bin/darex-prod-failfast"]
CMD ["pnpm", "--filter", "@darex/workflows", "start:bridge"]
