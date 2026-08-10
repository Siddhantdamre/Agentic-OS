FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable pnpm

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @darex/workflows build

FROM node:20-slim AS runner
WORKDIR /app
RUN corepack enable pnpm

ENV NODE_ENV production

COPY --from=builder /app ./

CMD ["pnpm", "--filter", "@darex/workflows", "start:bridge"]
