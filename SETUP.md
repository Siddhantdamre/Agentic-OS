# Setup & Startup Guide

Cross-platform setup and startup scripts for Darex on Windows, Mac, and Linux.

## Quick Start

### Mac / Linux
```bash
# First time: automatically runs setup if needed
./start.sh

# Or run setup explicitly
./setup.sh

# With options
./start.sh --dev        # infra only, run dashboard locally
./start.sh --no-build   # skip Docker rebuild
./start.sh --seed       # also seed database
./start.sh --down       # stop compose (keep volumes)
```

### Windows
```batch
REM First time: automatically runs setup if needed
start.bat

REM Or run setup explicitly
setup.bat

REM With options
start.bat --dev        # infra only, run dashboard locally
start.bat --no-build   # skip Docker rebuild
start.bat --seed       # also seed database
start.bat --down       # stop compose
```

## What Setup Does

`setup.sh` / `setup.bat` runs once to:

1. **Check Requirements**
   - Docker (running daemon)
   - Node.js (LTS+)
   - pnpm

2. **Environment**
   - Creates `.env` from `.env.example` if missing
   - Loads environment variables

3. **Dependencies**
   - `pnpm install` (workspace)
   - Builds shared types

4. **Docker**
   - Builds all images (docker-compose infrastructure)

5. **Database**
   - Starts Postgres container
   - Waits for Postgres ready
   - Runs migrations
   - Creates `.setup-done` marker

## What Start Does

`start.sh` / `start.bat` runs repeatedly to:

1. **Auto-Setup** — If `.setup-done` missing, runs `setup.sh` first
2. **Build** — Rebuilds Docker images (unless `--no-build`)
3. **Start** — `docker-compose up -d` (all services)
4. **Migrate** — Latest schema version
5. **Seed** — If `--seed` (optional, connectivity check)
6. **Health** — Polls `/api/health` until ready (or timeout)
7. **Display** — Prints URLs and status

## Installation Requirements

### Mac
```bash
# Homebrew
brew install docker node
npm install -g pnpm

# Or Docker Desktop (includes docker & docker-compose)
# Download: https://www.docker.com/products/docker-desktop
```

### Linux (Ubuntu/Debian)
```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose nodejs npm

npm install -g pnpm

# Add user to docker group (optional, avoids sudo)
sudo usermod -aG docker $USER
```

### Windows
1. **Docker Desktop** — https://www.docker.com/products/docker-desktop
2. **Node.js** — https://nodejs.org (LTS)
3. **pnpm** — Open PowerShell/CMD, run `npm install -g pnpm`
4. **Git Bash** (recommended for `.sh` scripts on Windows)
   - Download from https://git-scm.com
   - Or use PowerShell/CMD directly with `.bat` scripts

## Troubleshooting

### Docker daemon not running
```bash
# Mac: Start Docker Desktop
# Windows: Start Docker Desktop
# Linux: sudo systemctl start docker
```

### Permission denied on setup.sh / start.sh
```bash
chmod +x setup.sh start.sh
```

### Port already in use
- Dashboard: 3000
- Nango: 3003
- Langfuse: 3002
- Temporal UI: 8233
- LiteLLM: 4000

Modify ports in `.env` or `infra/docker-compose.yml`.

### Postgres migration fails
```bash
# Check migration logs
docker logs darex-postgres

# Or manually:
docker exec -it darex-postgres psql -U darex -d darex -c "\dt"
```

### Remove setup marker to re-run setup
```bash
rm .setup-done
./start.sh  # Will run setup again
```

## Ports & Services

| Service | Port | Purpose |
|---------|------|---------|
| Dashboard | 3000 | Next.js app |
| Nango OAuth | 3003 | OAuth integrations |
| Langfuse | 3002 | LLM observability |
| Temporal UI | 8233 | Workflow orchestration |
| LiteLLM | 4000 | LLM routing |
| Inbox | 3004 | WhatsApp/Email ingestion |
| atomic-agent | 8787 | Agent sandbox |
| MCP bridge | 8790 | Model Context Protocol |

## Environment Variables

Copy `.env.example` to `.env` and update:

- `DB_*` — Postgres (dev defaults safe)
- `SUPERTOKENS_*` — Auth service
- `NANGO_*` — OAuth provider credentials
- `LITELLM_*` — LLM routing config
- `EMBEDDING_MODEL` — Vector DB (default: text-embedding-3-small)
- API keys for live integrations (WhatsApp, Gmail, Slack, etc.)

## Development

### Start with local dashboard
```bash
./start.sh --dev
# Then in another terminal:
cd apps/dashboard
pnpm dev  # or already running from start.sh output
```

### Run database seed (connectivity test only)
```bash
./start.sh --seed
```

### Stop without losing volumes
```bash
./start.sh --down
```

### Logs
```bash
pnpm infra:logs        # all docker logs
docker logs <service>  # specific service
```

## Scripts Overview

| Script | Platform | Purpose |
|--------|----------|---------|
| `setup.sh` | Mac, Linux | One-time full setup |
| `start.sh` | Mac, Linux | Start everything (auto-setup if needed) |
| `setup.bat` | Windows | One-time full setup |
| `start.bat` | Windows | Start everything (auto-setup if needed) |
| `infra/docker-compose.yml` | All | Container orchestration |
| `infra/scripts/compose-cmd.sh` | Mac, Linux, Git Bash | Compose wrapper (snippets + overlays) |
| `infra/db/migrate.js` | All (via Node) | Database schema migrations |
| `infra/db/seed.js` | All (via Node) | Test data seed |

## First Run Checklist

- [ ] Install Docker, Node, pnpm
- [ ] Clone repo
- [ ] Run `./start.sh` (or `start.bat` on Windows)
- [ ] Wait for "Darex is up" message
- [ ] Open http://localhost:3000
- [ ] Register → Connectors → Ask AI
- [ ] Update `.env` with real API keys (OAuth, LLMs, etc.)
