output "endpoint" {
  description = "RDS address, or null when db_master_password is unset (plan-only)."
  value       = try(aws_db_instance.this[0].address, null)
}

output "port" {
  value = 5432
}

output "security_group_id" {
  value = aws_security_group.rds.id
}
