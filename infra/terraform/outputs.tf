output "vpc_id" {
  description = "VPC id."
  value       = module.vpc.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet ids (RDS, Redis, app)."
  value       = module.vpc.private_subnet_ids
}

output "public_subnet_ids" {
  description = "Public subnet ids (ALB, NAT)."
  value       = module.vpc.public_subnet_ids
}

output "rds_endpoint" {
  description = "RDS hostname (connect as darex for migrations, darex_app at runtime)."
  value       = module.rds.endpoint
}

output "redis_endpoint" {
  description = "ElastiCache primary endpoint."
  value       = module.redis.primary_endpoint
}

output "secret_arns" {
  description = "Secrets Manager ARNs. Values are not in this output."
  value       = module.secrets.secret_arns
}

output "alb_dns_name" {
  description = "ALB DNS name when domain_name is set; otherwise null."
  value       = try(module.https[0].alb_dns_name, null)
}

output "acm_validation_records" {
  description = "ACM DNS validation records when Route53 zone is not supplied."
  value       = try(module.https[0].acm_validation_records, null)
}
