# Darex code sandbox — unprivileged python/node/bash exec.
# Callers: compose service `sandbox` (infra/docker-compose.yml ~line 470);
# tool-executor POST /execute. Glob found no existing sandbox Dockerfile.
# No tenant data files. User: "Sandbox Docker context missing".
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 bash ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin sandbox

WORKDIR /app
COPY server.mjs ./server.mjs

USER sandbox
ENV SANDBOX_PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
