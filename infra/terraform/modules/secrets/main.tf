# Secret *containers* only. Values come from terraform.tfvars (gitignored)
# or from the AWS console/CLI. This module never hardcodes passwords.

resource "aws_secretsmanager_secret" "db_master" {
  name        = "${var.name_prefix}/${var.environment}/db-master"
  description = "RDS master password (migrations as darex). Value not in git."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "db_master" {
  count         = var.db_master_password != null ? 1 : 0
  secret_id     = aws_secretsmanager_secret.db_master.id
  secret_string = var.db_master_password
}

resource "aws_secretsmanager_secret" "app_db" {
  name        = "${var.name_prefix}/${var.environment}/app-db"
  description = "Runtime DB_USER=darex_app password. Value not in git."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app_db" {
  count         = var.app_db_password != null ? 1 : 0
  secret_id     = aws_secretsmanager_secret.app_db.id
  secret_string = var.app_db_password
}

resource "aws_secretsmanager_secret" "nango" {
  name        = "${var.name_prefix}/${var.environment}/nango"
  description = "Nango UUID secret key. Set the value out of band; never commit."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "litellm" {
  name        = "${var.name_prefix}/${var.environment}/litellm"
  description = "LiteLLM master key + provider keys. Set out of band."
  recovery_window_in_days = 7
}
