# Production Deployment Guide

Deploy Darex to Ubuntu/Linux servers with full setup, validation, and health checks.

## Quick Start

### From Server (after cloning repo)
```bash
cd /opt/darex
cp deploy/env.production.example .env
# Edit .env with real secrets
./deploy/deploy.sh
```

### From Laptop (push to remote)
```bash
DEPLOY_HOST=ubuntu@203.0.113.10 DEPLOY_PATH=/opt/darex ./deploy/deploy.sh
```

## What deploy.sh Does

### 1. Pre-flight Checks (--no-setup to skip)
- OS detection (Ubuntu/Debian)
- Docker daemon running
- Node.js installed
- Disk space ≥10GB
- Memory ≥4GB

### 2. Environment Validation
- `.env` file exists
- All required secrets present (not placeholders)
- `ALLOW_DEMO_AUTH=false` (production only)
- `DB_USER=darex_app` (least privilege)
- `NEXT_PUBLIC_APP_URL` must be https://

### 3. Build & Deploy
- Docker images build
- Services start (docker-compose with prod overlay)
- Postgres migration runs
- Database schema updated

### 4. Health Validation
- Dashboard /api/health responding
- Postgres ready
- All containers running
- Docker disk usage normal

### 5. Final Status Report
- All service URLs
- Security checklist
- Admin tunnel instructions
- Operations cheat sheet

## Server Setup (Ubuntu 20.04 LTS+)

### 1. Create deploy user
```bash
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/darex
sudo chown deploy:deploy /opt/darex
```

### 2. Install Docker
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Enable Docker on boot
sudo systemctl enable docker
sudo systemctl start docker
```

### 3. Install Node.js (LTS)
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git curl
```

### 4. Install pnpm
```bash
npm install -g pnpm
```

### 5. Clone repo
```bash
sudo -u deploy git clone https://github.com/yourepo/darex.git /opt/darex
cd /opt/darex
sudo -u deploy git checkout main  # or production branch
```

## Configuration

### .env (Production)
Copy `deploy/env.production.example` to `.env`:
```bash
# Database (least privilege)
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=darex_app
DB_PASSWORD=<long-random-string>
DB_NAME=darex

# SuperTokens (auth)
SUPERTOKENS_CONNECTION_URI=http://127.0.0.1:3567
SUPERTOKENS_API_KEY=<your-key>

# Session (JWT secret)
DAREX_SESSION_SECRET=<long-random-string>

# App
NEXT_PUBLIC_APP_URL=https://app.yourcompany.com  # MUST be https://

# Nango (OAuth provider)
NANGO_HOST=http://127.0.0.1:3003
NANGO_SECRET_KEY=<UUID-from-nango>
NEXT_PUBLIC_NANGO_PUBLIC_KEY=<public-key>

# LiteLLM (LLM routing)
LITELLM_BASE_URL=http://127.0.0.1:4000
LITELLM_MASTER_KEY=<long-random-string>

# Embedding model
EMBEDDING_MODEL=text-embedding-3-small

# LLM Provider
OPENROUTER_API_KEY=<your-key>
ATOMIC_AGENT_API_KEY=<your-key>

# Integrations (optional, for live features)
JINA_API_KEY=<for-web-search>
NANGO_WHATSAPP_KEY=<if-using-whatsapp>
META_ACCESS_TOKEN=<if-using-whatsapp>
```

## Deployment

### Initial Deploy
```bash
# From server
cd /opt/darex
./deploy/deploy.sh

# From laptop (via SSH + rsync)
DEPLOY_HOST=deploy@203.0.113.10 DEPLOY_PATH=/opt/darex ./deploy/deploy.sh
```

### With Options
```bash
./deploy/deploy.sh --no-build      # Skip image rebuild
./deploy/deploy.sh --no-setup      # Skip preflight checks (if already done)
./deploy/deploy.sh --status        # Show current status only
./deploy/deploy.sh --down          # Stop all services
```

## Reverse Proxy Setup (Caddy)

Dashboard is loopback-only (127.0.0.1:3000). Use Caddy/nginx:

### Caddy (recommended)
```bash
# Install Caddy
sudo apt-get install -y caddy

# Copy config
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile

# Edit with your domain
sudo nano /etc/caddy/Caddyfile
# Set domain and email

# Reload Caddy
sudo systemctl reload caddy
```

### Nginx (alternative)
```bash
upstream darex {
  server 127.0.0.1:3000;
}

server {
  listen 443 ssl http2;
  server_name app.yourcompany.com;

  ssl_certificate /path/to/cert.pem;
  ssl_certificate_key /path/to/key.pem;

  location / {
    proxy_pass http://darex;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Post-Deploy Checklist

- [ ] `./deploy/deploy.sh --status` shows all green
- [ ] `curl https://app.yourcompany.com/api/health` returns 200
- [ ] Caddy/nginx proxying to loopback :3000
- [ ] Database migrations applied
- [ ] All environment variables set (no placeholders)
- [ ] ALLOW_DEMO_AUTH=false
- [ ] Real OAuth client IDs in Nango UI
- [ ] LLM API keys active (OpenRouter, etc.)
- [ ] WhatsApp META token valid if using
- [ ] Gmail API credentials if using email
- [ ] Slack app installed if using

## Monitoring & Operations

### Status
```bash
./deploy/deploy.sh --status
```

### Logs
```bash
# All docker services
docker compose -f infra/docker-compose.yml -f deploy/docker-compose.prod.yml logs -f

# Specific service
docker logs -f darex-dashboard
docker logs -f darex-postgres
docker logs -f darex-worker

# Dashboard app logs
docker exec darex-dashboard tail -f /var/log/darex-dashboard.log
```

### Restart Services
```bash
# All services
docker compose -f infra/docker-compose.yml -f deploy/docker-compose.prod.yml restart

# Specific service
docker restart darex-dashboard
docker restart darex-postgres
```

### Database Access
```bash
# Connect as superuser
docker exec -it darex-postgres psql -U darex -d darex

# Connect as app user
docker exec -it darex-postgres psql -U darex_app -d darex

# Run query
docker exec darex-postgres psql -U darex -d darex -c "SELECT version();"
```

### Admin UI Access (SSH tunnels)
```bash
# From your laptop
ssh -L 3003:127.0.0.1:3003 -L 3002:127.0.0.1:3002 -L 8233:127.0.0.1:8233 deploy@server

# Then open:
# Nango: http://localhost:3003
# Langfuse: http://localhost:3002
# Temporal: http://localhost:8233
```

## Troubleshooting

### Dashboard not responding
```bash
# Check logs
docker logs darex-dashboard

# Check health endpoint
curl -v http://127.0.0.1:3000/api/health

# Restart
docker restart darex-dashboard
```

### Database migration failed
```bash
# Check migration status
docker exec darex-postgres psql -U darex -d darex -c "\dt" | grep migrations

# Re-run migrations
docker exec darex-postgres rm -f /app/lock.sql
docker restart darex-worker

# Or manually re-run
cd /opt/darex
DB_HOST=127.0.0.1 DB_USER=darex DB_PASSWORD=$DB_PASSWORD DB_NAME=darex \
  node infra/db/migrate.js
```

### Port already in use
Services bind to loopback only (127.0.0.1), so conflicts are rare. Check:
```bash
# What's listening on 3000
sudo lsof -i :3000

# What's listening on 5432 (Postgres)
sudo lsof -i :5432

# Kill container if stuck
docker kill darex-dashboard
```

### High disk usage
```bash
# Check Docker disk
docker system df

# Clean unused images/volumes
docker system prune -a --volumes

# Check compose volumes
docker volume ls | grep darex
docker volume inspect darex-postgres-data
```

### Out of memory
Increase swap or add memory:
```bash
# Check current memory
free -h

# Add 4GB swap (temporary)
sudo dd if=/dev/zero of=/swapfile bs=1G count=4
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Permanent: add to /etc/fstab
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Backup & Recovery

### Database Backup
```bash
# Daily backup to /backups/darex
docker exec darex-postgres pg_dump -U darex -d darex > /backups/darex-$(date +%Y%m%d).sql

# Restore from backup
docker exec -i darex-postgres psql -U darex -d darex < /backups/darex-20240101.sql
```

### Docker Volume Backup
```bash
# Backup postgres volume
docker run --rm -v darex-postgres-data:/data -v /backups:/backup \
  alpine tar czf /backup/darex-postgres-$(date +%Y%m%d).tar.gz -C /data .

# Restore volume backup
docker volume rm darex-postgres-data
docker volume create darex-postgres-data
docker run --rm -v darex-postgres-data:/data -v /backups:/backup \
  alpine tar xzf /backup/darex-postgres-20240101.tar.gz -C /data
```

### Full System Backup (before updates)
```bash
# Backup entire /opt/darex
tar czf /backups/darex-full-$(date +%Y%m%d).tar.gz /opt/darex

# Restore
tar xzf /backups/darex-full-20240101.tar.gz -C /
```

## Updates & Rollback

### Update Code
```bash
cd /opt/darex
git fetch origin
git checkout origin/main  # or production branch
./deploy/deploy.sh --no-setup
```

### Rollback to Previous Version
```bash
cd /opt/darex
git log --oneline -10  # Find commit
git checkout <commit-hash>
./deploy/deploy.sh --no-setup
```

## Security Best Practices

1. **Secrets Management**
   - Never commit .env to git
   - Rotate API keys every 90 days
   - Use unique DB passwords per environment
   - Store SSH keys with restricted permissions (600)

2. **Network**
   - Dashboard loopback only (127.0.0.1)
   - Reverse proxy (Caddy) handles HTTPS
   - Admin UIs via SSH tunnel only
   - Firewall: only 80/443 public

3. **Access Control**
   - `deploy` user (non-root) runs containers
   - `docker` group membership for deploy user
   - No sudo for deploy user in /etc/sudoers
   - SSH key-based auth (no passwords)

4. **Monitoring**
   - Set up log aggregation (ELK, Datadog)
   - Monitor disk/memory/CPU
   - Alert on /api/health failures
   - Backup DB daily

5. **Updates**
   - Test updates in staging first
   - Backup before major version bumps
   - Keep Docker/OS patched
   - Subscribe to security advisories

## Performance Tuning

### Database (Postgres)
```bash
# Increase connections (if needed)
docker exec darex-postgres psql -U darex -d darex \
  -c "ALTER SYSTEM SET max_connections = 200;"

# Enable query logging (debug only)
docker exec darex-postgres psql -U darex -d darex \
  -c "ALTER SYSTEM SET log_statement = 'all';"

# Restart after config changes
docker restart darex-postgres
```

### Node.js Heap
Increase Node.js memory in docker-compose.prod.yml:
```yaml
environment:
  NODE_OPTIONS: "--max-old-space-size=2048"
```

### Redis (if added)
For rate limiting / session caching, add Redis service and update .env.

## Support & Debugging

### Collect Debug Bundle
```bash
# Create debug tarball
cd /opt/darex
mkdir -p /tmp/darex-debug

docker compose -f infra/docker-compose.yml -f deploy/docker-compose.prod.yml logs --tail=1000 > /tmp/darex-debug/docker-logs.txt
docker stats --no-stream > /tmp/darex-debug/docker-stats.txt
docker compose -f infra/docker-compose.yml -f deploy/docker-compose.prod.yml ps > /tmp/darex-debug/docker-ps.txt
docker system df > /tmp/darex-debug/docker-df.txt
docker exec darex-postgres pg_dump -U darex -d darex --schema-only > /tmp/darex-debug/schema.sql

tar czf /tmp/darex-debug-$(date +%Y%m%d-%H%M%S).tar.gz /tmp/darex-debug
```

## Contact & Resources

- Docs: See README.md, SETUP.md
- Issues: GitHub issues or internal tracker
- Deploy script: `./deploy/deploy.sh --help`
- Status: `./deploy/deploy.sh --status`
