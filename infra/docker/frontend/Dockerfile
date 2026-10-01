# Frontend — the DareX ai Next.js app in NEW-FRONTEND (live mode, not the mock demo).
# Build context must be NEW-FRONTEND/ (its own git repo). /api/* is proxied to the dashboard;
# Next resolves that rewrite at build time, so DASHBOARD_URL is a build arg.
# Uses Next's standalone output: the runner holds only the traced files, not node_modules.
#
# Build:
#   docker build -f infra/docker/frontend/Dockerfile --build-arg DASHBOARD_URL=http://dashboard:3000 \
#     -t darex-frontend NEW-FRONTEND
# Run (managed by deploy/docker-compose.prod.yml): port 3100.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The npm cache mount keeps downloads between builds; the layer only reruns when the lockfile changes.
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
ARG DASHBOARD_URL=http://dashboard:3000
ENV DASHBOARD_URL=$DASHBOARD_URL
# NEXT_PUBLIC_DEMO stays unset: this is the live build.
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:3100/sign-in',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
