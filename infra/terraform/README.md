# Darex Terraform starter (wave 1 / I5)

AWS skeleton for **VPC, RDS Postgres, ElastiCache Redis, Secrets Manager,
and HTTPS (ALB + ACM)**. It does not replace the current single-host
deploy (`deploy/docker-compose.prod.yml` + Caddy). Local PgBouncer, restore
drill, and alerting probes are in compose/scripts (wave 3). AWS apply is
still optional and must not embed secrets in these modules.

**No secrets live in these modules.** Pass them via an uncommitted
`terraform.tfvars` (see `.gitignore`). Example values are placeholders
only.

## Variables (required conceptually)

| Name | Purpose | Example (not a secret) |
|------|---------|------------------------|
| `aws_region` | AWS region | `ap-south-1` |
| `vpc_cidr` | VPC CIDR | `10.20.0.0/16` |
| `db_instance_class` | RDS class | `db.t3.medium` |
| `db_master_password` | RDS master password | set in `terraform.tfvars` only |
| `app_db_password` | `darex_app` runtime role | set in `terraform.tfvars` only |

Optional: `domain_name` (enables ACM + ALB). Empty skips HTTPS resources.

Secrets Manager shells (no values in git): `db-master`, `app-db`,
`darex-billing` (B2 Stripe/Razorpay **platform** keys), `darex-sso`
(S7 SuperTokens IdP). Paste live values in the AWS console. These are
not customer PSP payment-link credentials.

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # gitignored
# edit terraform.tfvars — real passwords, never commit
terraform init
terraform plan
# terraform apply   # staging only; not required for local Phase 0/6
```

Remote state (S3) is documented in `backend.hcl.example`. Default backend
is local; `*.tfstate` is gitignored.

After RDS exists, enable pgvector the same way local init does:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

App connections use `darex_app` (`DB_USER=darex_app`). Migrations still
run as the master user.

## Wave 3 (compose) vs AWS

| Item | Where |
|------|--------|
| PgBouncer | local `darex-pgbouncer`; AWS notes in `modules/pgbouncer/README.md` |
| Backup restore drill | `infra/scripts/restore-drill.sh` + `modules/backups/README.md` |
| Alerting | `infra/scripts/alerting-*.js` |

## Compose remains the kernel

Local and single-host prod boot from `infra/docker-compose.yml`
(20 services, including PgBouncer) plus `deploy/docker-compose.prod.yml`.
This Terraform tree is the future AWS shape, not a second compose kernel.
No secrets in these modules.
