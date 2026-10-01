# Marketplace preview (Phase 15 / B5)

Design only. **Do not build a public skill store.** First-party skill
versions are listed in the dashboard at `/skills`. Third-party packs
must not run in a tenant until this review process is implemented and
memory, confirm, and audit are solid.

Linked from workstream 14 (B5) and Phase 15.

---

## 1. What ships now

- First-party playbooks under `infra/docker/atomic-agent/custom-skills/`
  with a `version` in SKILL.md frontmatter (currently `1.0.0`).
- Dashboard **Skills** page lists those versions. It is not a catalog
  of other vendors.
- Darex SaaS billing (`/billing`) is unrelated to the org Stripe /
  Razorpay **payment-link** skill. That skill charges the tenant's
  customers; Darex never escrows those funds.

---

## 2. What must not ship yet

- A public marketplace, browse/search of third-party packs, or
  one-click install from the internet.
- Running an unreviewed pack (or a pack that embeds raw OAuth tokens,
  private keys, or another tenant's secrets).
- Cross-org training or silent promotion of another tenant's plans
  into this org.

---

## 3. Third-party pack review (when we build it)

A pack is allowed in a tenant only after **all** of:

1. **Executor only.** The pack calls existing `mcp.darex.*` tools (or
   a reviewed new executor). It must not ship a sidecar that holds
   tokens, scrape credentials, or bypass Nango.
2. **No raw tokens in the pack.** Secrets stay in Nango / env /
   `channels.meta` for that org. Pack YAML/JSON must not include
   bearer tokens.
3. **Eval-runner.** A golden set in `infra/evals/` that the pack
   must pass (honest `notConnected`, no invented SoR rows). Fail =
   do not install.
4. **Admin install.** Only `owner` / `admin` can attach a reviewed
   pack to the org. Auditor cannot install or call `pay` tools.
5. **Named human promotion.** If a playbook is promoted from traces,
   a human names it. No silent cross-tenant copy.

Review artifact (future): `pack_reviews` row with reviewer, eval run
id, decision (`approved` / `rejected`), and the content hash of the
pack tarball. Unsigned or hash-mismatched packs refuse to load.

---

## 4. Versioning first-party skills

- Bump `version` in SKILL.md when tools or confirm policy change.
- The Skills page is the operator view of what the runtime loaded.
- Breaking MCP tool renames need a migration note in current-working;
  do not leave two executors for the same action.

---

## 5. Tenancy

Packs are org-scoped once installed. RLS still applies to every tool
call (`org_id` from session / workflow input, never from an untrusted
body). A pack for org A must not read org B memory, invoices, or
connectors.

---

## 6. Exit (Phase 15 DoD)

- First-party skill versioning UI exists (`/skills`).
- This document is the written third-party process.
- No unreviewed pack can run.
- No public store.
