# Deploying Darex to a fresh server

You run these. Nobody needs your SSH key or your passwords.

Total hands-on time is about ten minutes; the machine then builds images for
fifteen to twenty-five on its own.

---

## Before you start: what this will and will not prove

**It will prove** the software installs on a machine that has never seen it,
every service becomes healthy, migrations apply, one tenant cannot read
another, a backup restores, the stack survives a restart, and a rollback still
serves traffic.

**It will not prove the agent answers well.** That needs live model calls. With
an empty OpenRouter balance every model tier returns `429` and the agent
escalates to a human instead of replying. That is the fallback working
correctly — it is not a broken install, and it is not a working product either.
The script says so at the end rather than letting you read a green banner and
assume otherwise.

So the honest outcome of this runbook is: **a correctly deployed system that
cannot yet do its job.** Funding the model account is what turns it into a
product, and it is one step, later, on this same box.

---

## 1. The machine

| | |
|---|---|
| **OS** | Ubuntu 22.04 LTS — the pre-flight checks assume `apt`, and this is what the fixes were proven against |
| **RAM** | **8 GB.** Not 2, not 4 |
| **Disk** | 80 GB |
| **Examples** | Hetzner CX32 (~€7/mo), DigitalOcean 8 GB (~$48/mo), Vultr 8 GB |

The memory number is measured, not guessed: the running stack sits at **3.76 GB
across 18 containers**, and the image build peaks well above that. A 2 GB box
does not fail cleanly — it OOM-kills the build half way through and looks like a
broken deployment for an hour. The script refuses to start on one.

---

## 2. Run it

SSH in as a user with `sudo`, then:

```bash
curl -fsSL https://raw.githubusercontent.com/Siddhantdamre/Agentic-OS/main/deploy/provision.sh -o provision.sh
bash provision.sh --openrouter-key sk-or-v1-YOUR-KEY-HERE
```

Use your real OpenRouter key even though the balance is empty. `deploy.sh`
refuses to start without one, correctly: a deployment that cannot reach a model
is not a deployment.

**It is safe to re-run.** Every step checks before it acts, and secrets are
generated exactly once — rotating `DB_PASSWORD` against an existing Postgres
volume is how you lock yourself out of your own database.

### What you will see

```
==> Checking this machine can actually run it
    [ok] OS: Ubuntu 22.04.5 LTS
    [ok] memory: 7788MB
    [ok] disk: 78GB free
==> Installing prerequisites
==> Fetching the application
==> Configuring secrets
    [ok] generated 8 secrets into .env (mode 600, never printed)
==> Deploying (first run builds images — expect 15-25 minutes)
==> Waiting for the application to answer
==> Verifying — this is the part that matters
```

Then roughly 33 suites. **Send me that block** and I will read it properly.

---

## 3. Then prove recovery

Once it reports DEPLOYED:

```bash
cd ~/darex
node infra/scripts/check-deploy-recovery.js --rollback
bash infra/scripts/restore-drill.sh --execute
```

The first restarts the whole stack, kills an optional service on purpose, and
proves the application still serves and can be rolled back. The second proves a
backup restores **with the tenant wall intact** — a restore that silently drops
row-level security is worse than losing the backup, because it looks like
success.

Send me both outputs.

---

## 4. If something fails

Read the failure before restarting anything. The script is written so each one
means a specific thing.

| What you see | What it means | What to do |
|---|---|---|
| `FAILED: only 2048MB RAM` | The box is too small | Resize to 8 GB. Do not try to push through it |
| `FAILED: docker compose 2.20 is too old` | Compose predates the `!override` tag | `sudo apt-get install --only-upgrade docker-compose-plugin`. **Do not skip this** — without it the production config publishes every port twice *and* leaves the database bound to `0.0.0.0` |
| `FAILED: no OpenRouter key` | Flag missing | Re-run with `--openrouter-key` |
| `ENVIRONMENT UNAVAILABLE` from the verifier | The stack is not reachable | **Nothing was verified.** Not a code failure. `sudo docker ps` and look for a container that is not `Up` |
| `never answered /api/health within 300s` | The app did not come up | `sudo docker compose -f infra/docker-compose.yml logs --tail 80 dashboard` |
| A suite reports `FAIL` | A real defect | Paste it to me verbatim. Do not re-run hoping for green |
| `infrastructure alarms` FAIL, balance exhausted | The OpenRouter wallet | Expected today. It is reported as an advisory, not a failure |

**Never re-run a failing suite to get a green.** Every check in there was
written because something was once silently wrong; a flake would be a defect in
its own right and I want to see it.

---

## 5. Locking it down

The production overlay binds **everything to `127.0.0.1` on purpose.** Nothing
in the stack is meant to face the internet directly — not Postgres, not Redis,
not Temporal, not the LiteLLM proxy.

So after the deploy:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Then put Caddy in front of `127.0.0.1:3000` using `deploy/Caddyfile.example`,
point a domain at the box, and set `NEXT_PUBLIC_APP_URL` in `~/darex/.env` to
that domain. The script sets it to `https://<your-ip>` so the config check
passes honestly; it is not a working TLS setup on its own.

Verify the lockdown from **your laptop**, not from the server:

```bash
nc -vz YOUR_SERVER_IP 5432    # must be refused — that is Postgres
nc -vz YOUR_SERVER_IP 4000    # must be refused — that is the model proxy
```

If either connects, stop and tell me. That is the failure mode I care most
about: the base compose file publishes `5432:5432` on all interfaces and the
production overlay is what replaces it. That override was broken until
recently, and `lint-compose-ports.js` now fails the build if it regresses — but
verify it on the real machine anyway.

---

## Tracing is off, on purpose

The first deploy does **not** start Langfuse. That is a decision, not an
oversight.

Measured on the development stack: Langfuse is **2.47 GB of a 4.05 GB idle
footprint — 61%** — across ClickHouse, MinIO, its own Redis, a server and a
worker. Everything that actually answers a customer fits in about 1.6 GB. On a
6 GB box, running it from day one spends most of your headroom observing a
system with no traffic to observe.

Nothing depends on it. No worker, dashboard or inbox service has a `depends_on`
pointing at Langfuse, which is why it can be gated behind a compose profile
rather than untangled.

Turn it on when there is something worth tracing:

```bash
docker compose --profile observability up -d
```

To make that permanent on the server, put `COMPOSE_PROFILES=observability` in
`.env`. Local development already enables it — `start.sh` sets it for you — so
what you see while building is unchanged.

Budget roughly 2.5 GB extra when you do. On a 6 GB box that is comfortable
until real traffic arrives; past that, move Langfuse to its own machine rather
than shrinking the product to fit beside it.

## 6. Afterwards

```bash
cd ~/darex && git pull && ./deploy/deploy.sh   # update
./deploy/deploy.sh --status                    # what is running
node infra/scripts/verify.js                   # is it still sound
sudo docker compose -f infra/docker-compose.yml logs -f worker
```

Back up the database somewhere off the box. `restore-drill.sh` proves a restore
works; it does not store anything for you:

```bash
sudo docker exec darex-postgres pg_dump -U darex -d darex | gzip > darex-$(date +%F).sql.gz
```

**Keep `~/darex/.env` out of git and off your laptop.** It holds every secret
the deployment generated, and it is the only copy.

---

## The one step that turns this into a product

Fund the OpenRouter account, then, on the box:

```bash
cd ~/darex && node infra/scripts/check-e2e-agent-reply.js
```

That is the first run that answers *"can it actually do the job"* rather than
*"did it install correctly."* Everything above this line is necessary and none
of it is sufficient.
