output "secret_arns" {
  description = "Secrets Manager ARNs. Values are not exported."
  value = {
    db_master     = aws_secretsmanager_secret.db_master.arn
    app_db        = aws_secretsmanager_secret.app_db.arn
    darex_billing = aws_secretsmanager_secret.darex_billing.arn
    darex_sso     = aws_secretsmanager_secret.darex_sso.arn
  }
}
