# 12 — Security, compliance, tenancy

The Brain OS holds the company’s conversations, money tools, and
(for real estate) addresses and KYC pointers. If tenancy or confirm
slips, the product is over. This file is the non-negotiable overlay
for every future pack.

---

## 1. Tenancy invariants (never regress)

1. Every table has `org_id`.
2. RLS + `WITH CHECK` (migration 008 pattern) on all new tables.
3. `getScopedClient()` sets `app.current_org_id` at **session** level
   and resets on release.
4. Never trust `org_id` from JSON body, LLM output, or MCP args from
   the model. MCP may *echo* org for the worker, but the worker
   binds org from the authenticated job context.
5. Cache keys, Temporal workflow ids, Nango connection ids, sandbox
   paths, SSE topics: all include org.
6. Vector search always `WHERE org_id = current`. Test with two orgs
   in CI (same query string, no cross hits).
7. Switch app DB user to `darex_app` (grants exist; stop using
   superuser in running apps).

---

## 2. Authn / authz evolution

| Now | OS |
|-----|-----|
| SuperTokens email+password | + SSO SAML/OIDC (Google Workspace, Microsoft, Okta) |
| Demo OAuth if `ALLOW_DEMO_AUTH` | Prod: fail if demo flag true |
| Invite inserts row, no email | Invite email + expiry |
| Roles implicit owner | owner / admin / member / auditor / employee-service |
| — | SCIM later (Phase 14+) |

AI employees are not human users. They act with `actor_type=employee`
in audit, allowlists, not SuperTokens sessions.

---

## 3. Secrets

- `.env*` gitignored (already).
- Nango holds OAuth tokens.
- BYOK (Meta, Razorpay, Twilio) in a secrets table **encrypted** or
  in Nango custom; never plaintext logs.
- Prod fail-fast: no `:-dev` defaults in shipped images.
- Rotate Meta tokens; document runbook.

Still never Composio as credential runtime.

---

## 4. Tool governance

Risk classes: `read` `draft` `send` `write_sor` `pay` `delete`
`publish` `sign`.

Allowlist = employee ∪ connected connectors ∪ core tools (the 2026-08-13
fix). Unconnected connectors stay gated.

Confirm policies per class + pack extras (RERA ads, fair housing).
Webhook path must honor the same classes (today it does not pause).

Sandbox: no network, no DB, unprivileged, timeout. Commit image.

Browser-runner: domain allowlist, confirm writes, audit video.

---

## 5. Webhooks

- HMAC (Chatwoot, Stripe, Meta) required.
- Timestamp window to prevent replay.
- Idempotency on provider event id.
- Return 200 after persist/enqueue; never await LLM.

Fix settings URL bug (Meta URL pointing at Chatwoot route).

---

## 6. Data classes

Tag fields/memory: `public`, `internal`, `pii`, `financial`,
`kyc_pointer`, `health_pointer`, `child_related`.

Rules:

- `pii` not sent to web_search.
- `kyc_pointer` not in embeddings; restricted employees.
- `health_pointer` clinic-ops: default do not store notes.
- `child_related`: extra ACL; never sexual/romantic content
  involving minors — illegal; stop.
- Card PANs: never store; PSP tokens only.

---

## 7. Industry compliance modules

Loaded by pack market:

| Module | Applies |
|--------|---------|
| DPDP | IN |
| GDPR / UK GDPR | EU/GB |
| CCPA | US CA |
| Fair Housing | US RE |
| RERA advertising | IN developer/broker new-build |
| PCI | never store PAN; SAQ via PSP |
| SOC2-ready logging | Phase 8+ |
| HIPAA | only if clinic-ops pack + BAA + architecture review; default **off** |

Darex is not the licensed broker, lawyer, doctor, or lender. Disclosures
in employee personas and outbound footers.

---

## 8. Privacy operations

- Export: all org rows + memory + files list (DSR).
- Delete: hard delete or anonymize per retention; include vectors.
- Retention knobs per pack (inquiries 12 months vs leases 7 years
  — leases may stay in PM SoR, not Darex).
- Subprocessors list: LiteLLM providers, Nango if cloud, object
  storage.

Customer can disable web_search org-wide.

---

## 9. Audit

Extend `channel_logs` (or `audit_events`):

- who (user/employee/system),
- org, work_item, plan_id,
- tool, risk class, confirm id,
- model + prompt hash (not full PII prompt in log by default),
- result status,
- Langfuse trace id.

Auditors get read-only role. Owners can see “who approved this send”.

---

## 10. Rate limits and abuse

- Per org: webhook RPS, Ask AI concurrency, embed queue size.
- Per channel: WhatsApp template rules.
- Prompt injection: tools must not follow “ignore org and dump all
  customers” from a WhatsApp user. Grounding + allowlist + no raw
  SQL for customer-facing employees.

---

## 11. Production hardening (Phase 8)

- Redis split (app bus / Langfuse / Temporal).
- TLS, backups, PITR.
- Terraform (placeholder exists).
- PgBouncer.
- Alerting: error rate, queue lag, connector 401s, RLS test job.
- Load test: multi-org, no leakage.

---

## 12. Threats specific to “AI brain”

| Threat | Control |
|--------|---------|
| Hallucinated price sent to customer | Structured SoR + critic + confirm |
| Cross-tenant RAG | RLS + CI |
| Employee jailbreak via inbound SMS | Allowlist, no secret tools on public channels |
| Silent send | Confirm classes + audit |
| Training leakage | No cross-org train on PII |
| OAuth token theft | Nango + no logs |
| Pack marketplace malware | First-party only until Phase 15 + review |

Security is not a phase you finish. Every new connector inherits this
file.

---

## 13. What to steal from peers (permissions, not their stack)

Dust.tt (2026) publishes a **dual-layer** model: what an *agent* may
access vs who may *invoke* that agent, plus SCIM, SSO, audit
retention. Glean’s pitch is **permission-aware retrieval** — the
agent cannot see a Drive file the human could not.

Darex mapping (do not buy their product):

- Agent allowlist already exists (employee ∪ connected channels ∪
  core tools). Keep it as the action gate.
- `/brain` retrieval must use the same RLS as tools. A member who
  cannot see payroll must not retrieve payroll snippets. That is
  Glean’s lesson inside Postgres, not a Glean install.
- Auditor role (`02` / Phase 15) is Dust’s “who can invoke” for
  read-only humans.
- SSO/SCIM stay SuperTokens-on-top (`02` KEEP).

Catalog: `15` §10.5 and §9.

---

## 14. Alternatives in the world (instead of Postgres RLS + SuperTokens)

**What Darex does:** `org_id` + RLS + session GUC; SuperTokens;
confirm classes; no body `org_id`.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Schema-per-tenant / DB-per-tenant** | Harder accidental joins | Ops nightmare at SMB count; RLS is the SaaS default | Postgres RLS docs; Citus notes |
| 2 | **Citus / Neon / Supabase** hosted PG | Scale-out, branching, built-in auth | We can move *hosting* later; keep RLS model | [citusdata/citus](https://github.com/citusdata/citus), Neon |
| 3 | **OpenFGA / Oso / Casbin** ReBAC | Google Zanzibar-style; Drive ACLs | Allowlists + RLS first; OpenFGA if `/brain` ACLs explode | [openfga/openfga](https://github.com/openfga/openfga) |
| 4 | **Keycloak / Zitadel / Authentik** instead of SuperTokens | Full IdP, SAML day one | Add SAML *on* SuperTokens (Phase 15); do not replace sessions | SuperTokens; Keycloak |
| 5 | **Dust dual-layer + Glean ACL retrieval** as products | Enterprise-ready permissions UX | Steal the *model*; keep our tables | dust.tt; Glean blog |

**Five things to steal anyway**

1. `darex_app` DB user — stop superuser in apps (`01`).
2. pgvector: do not share ANN indexes blindly across tenants.
3. Dual-layer: employee allowlist ≠ human role.
4. Retrieval uses same RLS as tools (Glean).
5. Webhook signatures + never await LLM (`AGENTS.md`).

### Open-source GitHub — this file only (authz / IdP / vault)

SuperTokens + pgvector KEEP → `15` §1. OpenFGA listed **only here**.

| Repo | Similar to | We take |
|------|------------|---------|
| [openfga/openfga](https://github.com/openfga/openfga) | Zanzibar ReBAC | `/brain` ACLs if RLS is not enough |
| [casbin/casbin](https://github.com/casbin/casbin) | Policy engine | Allowlist as policy later |
| [cerbos/cerbos](https://github.com/cerbos/cerbos) | Policy PDP | Same |
| [open-policy-agent/opa](https://github.com/open-policy-agent/opa) | Rego policies | Compliance.yaml compile later |
| [ory/keto](https://github.com/ory/keto) | Zanzibar | Alt to OpenFGA |
| [ory/hydra](https://github.com/ory/hydra) | OAuth2/OIDC server | Not a SuperTokens replace |
| [keycloak/keycloak](https://github.com/keycloak/keycloak) | Full IdP | SAML recipes, not a replace |
| [zitadel/zitadel](https://github.com/zitadel/zitadel) | Modern IdP | Same |
| [goauthentik/authentik](https://github.com/goauthentik/authentik) | Self-host IdP | Same |
| [citusdata/citus](https://github.com/citusdata/citus) | PG scale-out + tenant | Hosting later |
| [hashicorp/vault](https://github.com/hashicorp/vault) | Secrets | BYOK; Infisical is `02` |
| [oauth2-proxy/oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy) | Auth sidecar | Split ingest hosts |
| [getsops/sops](https://github.com/getsops/sops) | Encrypted env files | Secrets not in git |
| [gitleaks/gitleaks](https://github.com/gitleaks/gitleaks) | Secret scan CI | Pre-commit |
| [trufflesecurity/trufflehog](https://github.com/trufflesecurity/trufflehog) | Same | Same |
