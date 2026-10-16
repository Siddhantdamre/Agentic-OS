# 12 — Self-Hosting with Caddy Reverse Proxy

Darex is self-hosted with TLS termination managed via Caddy reverse proxy, fronting the Next.js SaaS dashboard, the TrueForge agent harness, the Cognee knowledge graph memory service, and Nango integrations.

---

## 1. Domain & Routing Map

All subdomains route through Caddy with automatic TLS certificates via Let's Encrypt / ZeroSSL on public IP `135.235.136.6`:

| Domain | Upstream | Service | Health Check |
|---|---|---|---|
| `https://darex.135-235-136-6.sslip.io` | `10.0.0.4:3000` | Darex Dashboard (Next.js) | `GET /api/health` |
| `https://trueforge.135-235-136-6.sslip.io` | `10.0.0.4:8791` | TrueForge Agent Harness | `GET /healthz` |
| `https://cognee.135-235-136-6.sslip.io` | `10.0.0.4:8000` | Cognee Knowledge Graph | `GET /` |
| `https://nango.135-235-136-6.sslip.io` | `10.0.0.4:3003` | Nango Integration Server | `GET /health` |

---

## 2. Caddyfile Configuration

Located at `/home/darexai/mining-website/deploy/Caddyfile` and mounted by `mtip-caddy`:

```caddy
darex.135-235-136-6.sslip.io {
	encode gzip

	handle {
		reverse_proxy 10.0.0.4:3000 {
			flush_interval -1
		}
	}
}

trueforge.135-235-136-6.sslip.io {
	encode gzip

	handle {
		reverse_proxy 10.0.0.4:8791 {
			flush_interval -1
		}
	}
}

cognee.135-235-136-6.sslip.io {
	encode gzip

	handle {
		reverse_proxy 10.0.0.4:8000
	}
}

nango.135-235-136-6.sslip.io {
	encode gzip

	handle {
		reverse_proxy 10.0.0.4:3003
	}
}
```

Reload command:
```bash
docker exec mtip-caddy caddy reload --config /etc/caddy/Caddyfile
```

---

## 3. Systemd Services

Host services are managed by `systemd` under user `darexai`:

### `darex-dashboard.service` (`/etc/systemd/system/darex-dashboard.service`)
```ini
[Unit]
Description=Darex AI SaaS Dashboard
After=network.target docker.service

[Service]
Type=simple
User=darexai
WorkingDirectory=/home/darexai/Agentic-Os-SaaS/apps/dashboard
Environment=NODE_ENV=production
Environment=PORT=3000
Environment="PATH=/home/darexai/.nvm/versions/node/v24.18.0/bin:/home/darexai/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/home/darexai/.nvm/versions/node/v24.18.0/bin/pnpm --dir /home/darexai/Agentic-Os-SaaS --filter @darex/dashboard start
Restart=always
RestartSec=5
MemoryMax=1500M
MemoryHigh=1200M
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### Other Host Services
- `trueforge.service` — port 8791
- `cognee.service` — port 8000
- `trueforge-google-mcp.service` — port 8085

---

## 4. Docker Compose Services

Backing infrastructure in `infra/docker-compose.yml`:
- `darex-postgres` (`5432`)
- `darex-redis` (`6379`)
- `darex-supertokens` (`3567`)
- `darex-temporal` (`7233`) & `darex-temporal-ui` (`8233`)
- `darex-litellm` (`4000`)
- `darex-nango` (`3003`)
- `darex-pgbouncer` (`6432`)

---

## 5. Operations & Verification

```bash
# Check dashboard service status
sudo systemctl status darex-dashboard

# View live dashboard logs
journalctl -u darex-dashboard -f

# Verify HTTPS endpoints
curl -IL https://darex.135-235-136-6.sslip.io/login
curl -s https://darex.135-235-136-6.sslip.io/api/health
curl -s https://trueforge.135-235-136-6.sslip.io/healthz
curl -s https://cognee.135-235-136-6.sslip.io/
curl -s https://nango.135-235-136-6.sslip.io/health
```
