# Secret *containers* only. Values are pasted in AWS console / CI — never in .tf.
# Darex platform billing (B2) and SuperTokens SSO (S7) are app env, not customer PSP.

resource "aws_secretsmanager_secret" "db_master" {
  name        = "${var.name_prefix}/${var.environment}/db-master"
  description = "RDS master password (migrations). Runtime uses darex_app."
}

resource "aws_secretsmanager_secret_version" "db_master" {
  count         = var.db_master_password != null ? 1 : 0
  secret_id     = aws_secretsmanager_secret.db_master.id
  secret_string = var.db_master_password
}

resource "aws_secretsmanager_secret" "app_db" {
  name        = "${var.name_prefix}/${var.environment}/app-db"
  description = "darex_app runtime password."
}

resource "aws_secretsmanager_secret_version" "app_db" {
  count         = var.app_db_password != null ? 1 : 0
  secret_id     = aws_secretsmanager_secret.app_db.id
  secret_string = var.app_db_password
}

resource "aws_secretsmanager_secret" "darex_billing" {
  name        = "${var.name_prefix}/${var.environment}/darex-billing"
  description = "Darex platform Stripe/Razorpay keys (B2). Paste DAREX_STRIPE_* / DAREX_RAZORPAY_* in the console. Not org payment-link tools."
}

resource "aws_secretsmanager_secret" "darex_sso" {
  name        = "${var.name_prefix}/${var.environment}/darex-sso"
  description = "SuperTokens SAML/OIDC IdP credentials (S7). Paste SUPERTOKENS_SAML_* / Workspace / Okta / Azure values in the console."
}
