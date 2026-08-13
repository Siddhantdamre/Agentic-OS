output "secret_arns" {
  description = "ARNs only — secret strings are never outputted."
  value = {
    db_master = aws_secretsmanager_secret.db_master.arn
    app_db    = aws_secretsmanager_secret.app_db.arn
    nango     = aws_secretsmanager_secret.nango.arn
    litellm   = aws_secretsmanager_secret.litellm.arn
  }
}
