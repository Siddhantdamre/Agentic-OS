# MCP bridge — same workspace install as the dashboard image.
# BuildKit on this machine cannot resolve registry.npmjs.org (EAI_AGAIN),
# so this image does not run corepack or pnpm install. start.sh builds
# darex-dashboard:local first; that image already contains node_modules
# and services/workflows/dist.
FROM darex-dashboard:local
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/darex-prod-failfast"]
CMD ["node", "services/workflows/dist/mcp-bridge.js"]
