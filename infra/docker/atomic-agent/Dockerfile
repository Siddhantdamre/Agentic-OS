# Atomic Agent — Local-first agent runtime (pinned release v0.1.72)
# Builds from source (Node >= 25.7 required) and runs `atomic-agent serve`.
#
# Build:
#   docker build -f infra/docker/atomic-agent/Dockerfile -t darex-atomic-agent infra/docker/atomic-agent
# Run (managed by infra/docker-compose.yml):
#   docker run --rm -p 8787:8787 -e ATOMIC_AGENT_API_KEY=dev \
#     -e GROQ_API_KEY=$GROQ_API_KEY -e OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
#     -e GEMINI_API_KEY=$GEMINI_API_KEY -v atomic-agent-data:/data darex-atomic-agent

FROM node:25-bookworm AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
ARG ATOMIC_AGENT_TAG=v0.1.72
RUN git clone --depth 1 --branch "${ATOMIC_AGENT_TAG}" \
      https://github.com/AtomicBot-ai/atomic-agent.git .

# ── Local patches ────────────────────────────────────────────────────────────
# Applied against the pinned tag, BEFORE the build, and the build FAILS if a
# patch no longer applies. That is deliberate: a patch that silently no-ops on
# a version bump is the worst outcome — the image builds, the feature is
# missing, and nothing says so until somebody notices the data is wrong.
#
# 0001-tenant-attribution: forwards the tenant id (read from the namespaced
# session id) as the OpenAI `user` field, so the LiteLLM proxy can attribute
# spend per customer. Without it every call from every tenant is logged against
# the API key's owner and per-org budgets are impossible.
#
# 0002-per-request-model: lets the host choose the model PER REQUEST, read from
# the same namespaced session id. Upstream treats the model as a deployment
# setting - one per container - so a per-workspace spend cap could not bind the
# agent turn, the largest call the agent makes. Measured: a workspace over its
# cap, correctly detected and correctly recorded as degraded, still spent
# ~48,000 paid tokens because the container ignored the requested model.
COPY patches ./patches
RUN for p in patches/*.patch; do       echo "applying $p";       git apply --verbose "$p" || { echo "PATCH FAILED: $p does not apply to ${ATOMIC_AGENT_TAG} — reconcile it before bumping the tag"; exit 1; };     done

# Pin the lockfile's native deps (better-sqlite3) are compiled via prebuilds;
# fall back to source build if prebuilds are unavailable for this Node major.
RUN npm ci

# NOTE: package.json `build` only runs `tsc`; the copy-starter-skills step
# that ships starter skills is run via the postbuild script below.
RUN npm run build

# Official build emits dist/ with the CLI + sidecar entry points.
RUN test -f dist/cli/index.js && echo "dist/cli/index.js present" || { echo "build failed: dist/cli/index.js missing"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# Runtime stage
# ─────────────────────────────────────────────────────────────────────────────
FROM node:25-bookworm AS runner

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /src/package.json /src/package-lock.json ./
COPY --from=builder /src/dist ./dist
COPY --from=builder /src/grammars ./grammars
COPY --from=builder /src/starter-skills ./starter-skills
COPY --from=builder /src/assets ./assets
COPY --from=builder /src/node_modules ./node_modules
COPY custom-skills ./custom-skills
RUN cp -R /app/custom-skills/. /app/starter-skills/

# Runtime config renderer + entrypoint
COPY render-config.mjs ./render-config.mjs
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV ATOMIC_AGENT_STATE_DIR=/data
EXPOSE 8787

ENTRYPOINT ["./entrypoint.sh"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8787", "--cwd", "/work"]
