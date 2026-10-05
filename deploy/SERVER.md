# Production server notes

Facts about the one server Darex is deployed to, so deploy and tuning work starts
from what is actually there. Update this file when the server changes. Facts marked
"to check" were not confirmed. No secrets here (they live in the server's `.env`).

Last reviewed: 2026-10-01 (size and disk changed that day, see History).

## The machine

| | |
|---|---|
| Provider | Azure VM `Darexai-vm`, subscription "Azure subscription 1", resource group `Darexai`, Central India, availability zone 2 |
| OS | Ubuntu 24.04 LTS (Canonical `ubuntu-24_04-lts` server image), VM generation 2, x64, Azure agent 2.16.0.2 |
| Security | Trusted launch: secure boot and vTPM on, integrity monitoring off |
| Size | `Standard_E2as_v5`: 2 vCPU (AMD, 2 threads per core), **16 GiB RAM** (since 2026-10-01) |
| Pricing | **Azure Spot**, eviction policy Deallocate (see risks). About $9.65 per month Spot, about $52 regular (Azure retail prices, compute only) |
| Disk | One OS disk `Darexai-vm_OsDisk_1_...`, 61 GB until 2026-10-01 (resize to 128 GiB in progress: to check with `df -h /`), no data disk, 6 GB swap |
| Network | Public IP `135.235.136.6` (unchanged by the resize), DNS `xai.centralindia.cloudapp.azure.com`, private `10.0.0.4`, VNet `Darexai-vm-vnet/default`, NIC `darexai-vm426_z2` |
| Login | SSH (`AADSSHLoginForLinux` extension installed), Tailscale also runs |
| Not set | Auto-shutdown, health monitoring, hibernation |
| Created | Portal shows 10/5/2026 22:19 UTC (date order unclear) |

Sizes seen on this VM, so nobody repeats the mix-up: it started as `D2as_v5`
with **constrained vCPUs ("1 of 2")**, which is why `nproc` said 1 although the size
has 2 vCPU. It was briefly resized to `D2lds_v5` by mistake (only 4 GiB RAM), then
to `E2as_v5`. Other sizes priced for later (Central India, Spot / regular per
month): `D2ads_v5` $9 / $49, `D4as_v5` (4 vCPU, 16 GiB) $15 / $81, `E2ads_v5` $11.
In the portal's Size page, check the RAM column and the vCPUs column ("2 of 2", not
"1 of 2") before pressing Resize.

## What else runs on this VM

Darex shares the machine with two other projects. Plan memory and ports with them
in mind.

- **mtip** (about 11 containers, `~/mining-website`): includes `mtip-caddy`, which
  owns ports 80 and 443. It is the public entry point.
- **trueforge** (2 containers plus systemd services `trueforge`,
  `trueforge-controller`, `trueforge-google-mcp`): the MCP service listens on 8085,
  the harness on 8791.
- **cognee** (systemd, port 8000), **openclaw-gateway** (user service, 18789),
  **tailscaled**, **dockerd**.
- The old host-process dashboard (`darex-dashboard.service`) is disabled. Docker
  runs the dashboard now.

Idle floor with all containers stopped and those services off: about 750 MB RAM.

## Where Darex lives

- Repo: `~/Agentic-Os-SaaS`. Deploy from `main`.
- Deploy: `./deploy/deploy.sh --no-setup` (first run on a new box: `./deploy/deploy.sh`).
  Routine code push: `./deploy/redeploy.sh`. Both run in the background and stream their
  log, so closing the terminal or losing SSH does not stop them; reattach with `--logs`
  (state in `~/.local/state/darex-deploy/`). Status: `--status`. Stop: `--down`.
- Public URL comes from `NEXT_PUBLIC_APP_URL` in the server `.env`
  (`darex.135-235-136-6.sslip.io`, which has the IP in its name).
- HTTPS: `mtip-caddy` holds 80 and 443, so `deploy.sh` does not install Caddy. A
  route from the Darex host to `127.0.0.1:13100` must exist in that Caddy's config
  (to check: it is not set up yet).
- Backups taken before the 2026-10-01 wipe: `~/darex-db-backup.sql.gz` (Postgres
  dump) and `~/darex-repo-backup.bundle` (all branches; `feat/close-109-plan-gaps`
  had 30 commits that existed only on the server).

## Local-only images and sibling checkouts

The compose file builds two services from checkouts next to the repo, not from it:
`cognee` from `~/cognee` and the TrueForge image (`truefoundry-server:latest`) from
`~/trueforge` (`Dockerfile.dev`, with `infra/patches/trueforge/darex-tenant-headers.patch`
applied). `deploy.sh` builds the TrueForge image when it is missing and stops with a message
if the checkout is not there. Never run `docker image prune -a` on this VM: that image has no
registry copy and is deleted as soon as no container uses it. Use `docker image prune -f`.

## Ports

Darex binds loopback only (`deploy/docker-compose.prod.yml`, `ports: !override`).
Needed free on the host: 3000 dashboard, 3100 frontend, 5432 Postgres, 6432
PgBouncer, 6379 Redis, 7233 and 8233 Temporal, 3003 Nango, 3002 Langfuse, 3567
SuperTokens, 4000 LiteLLM, 3004 inbox, 8085 Evolution, 8787 sandbox, 8790 MCP bridge.

Clashes seen: 8085 (TrueForge Google MCP). Set `EVOLUTION_PORT` in `.env` to a free
port (for example 8086) if both must run. `deploy.sh` stops with the systemd unit's
name when a host process holds one of these ports.

## Risks and tuning, most important first

1. **Spot eviction.** Azure can take the VM back at any time (about 30 s notice) and
   leaves it stopped. A live site and mtip go down until someone starts it. Move to a
   regular VM before real customers: snapshot the OS disk, create a regular VM from
   it, keep the public IP.
2. **Public ports.** The NSG was not reviewed (to check). Nothing except 80, 443 and
   SSH should be open. Before 2026-10-01 Postgres (5432), the old dashboard (3000),
   Cognee (8000), Evolution (8085) and TrueForge (8791) listened on all interfaces.
3. **RAM.** 16 GiB now. Darex (about 17 services) plus mtip plus trueforge should
   fit. `deploy.sh` still skips the Langfuse stack (about 1.5 to 2.5 GB real use) on
   hosts under 12 GB RAM; at 16 GiB it starts it by itself (`LITE=1` skips it).
   Keep trueforge, cognee and openclaw off during builds anyway.
4. **CPU.** 2 vCPU after the 2026-10-01 resize (to check: `nproc --all` should print
   2). Next.js builds are slow; `deploy.sh` triples its health waits at 2 CPUs or
   fewer (dashboard about 9 min); if one still times out, rerun with `--no-build`.
   `D4as_v5` (4 vCPU, 16 GiB, about $15 Spot) is the next step up.
5. **Disk.** The first full build ran out of space (`no space left on device`)
   with about 18 GB free: Docker uses the containerd image store, which keeps layers
   twice, and `compose up --build` built 7 images at once. `deploy.sh` now builds one
   at a time. Was 81% full before cleanup (72% after). Docker build cache and
   images grow fast. The prod overlay now caps container logs at 10 MB x 3 and runs
   `init: true`; `deploy.sh` prunes build cache older than 7 days before a build.
   After the first full deploy `/` was at 62.7% of 122.94 GB (about 77 GB; breakdown
   not measured: run `docker system df` and `sudo du -xh /var/lib/docker
   /var/lib/containerd --max-depth=1 | sort -h | tail`). `deploy.sh` now skips builds
   already done for the same commits, removes dangling images after a good deploy and
   caps the build cache at 8 GB. Do not run `docker builder prune -af` before a deploy:
   it discards the cache and forces every dependency install to run again.
   Still open: a log cap for the mtip and trueforge projects.
6. **Domain.** The `sslip.io` name breaks if the public IP changes. The Azure DNS
   name above does not. Switching means a new `NEXT_PUBLIC_APP_URL`, a frontend
   rebuild and new OAuth redirect URIs.
7. **Updates.** About 4 OS updates were pending after the 2026-10-01 reboot.

## History

- 2026-10-01 (later): VM resized to `E2as_v5` (2 vCPU, 16 GiB) after the vCPU
  constraint and a wrong-row resize to `D2lds_v5` were found; OS disk growth to
  128 GiB started (VM deallocated for it). Not confirmed yet: `nproc --all`,
  `free -h` and `df -h /` after the restart.
- 2026-10-01: disk cleanup, old Darex stack and its volumes wiped on purpose (old
  code), old host services disabled, `deploy.sh` and the prod overlay fixed (see
  `BUILD_STATE.md`). First clean deploy pending.
