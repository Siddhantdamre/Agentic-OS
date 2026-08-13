variable "aws_region" {
  type        = string
  description = "AWS region for all resources."
  default     = "ap-south-1"
}

variable "name_prefix" {
  type        = string
  description = "Name prefix for VPC, RDS, Redis, ALB, and secrets."
  default     = "darex"
}

variable "environment" {
  type        = string
  description = "Environment tag (staging | production)."
  default     = "staging"
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC."
  default     = "10.20.0.0/16"
}

variable "db_instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t3.medium"
}

variable "db_name" {
  type        = string
  description = "Initial Postgres database name."
  default     = "darex"
}

variable "db_master_username" {
  type        = string
  description = "RDS master user (migrations). Runtime apps use darex_app."
  default     = "darex"
}

variable "db_master_password" {
  type        = string
  description = "RDS master password. Pass via terraform.tfvars — never commit."
  sensitive   = true
  default     = null
}

variable "app_db_password" {
  type        = string
  description = "Password for the darex_app runtime role. Pass via terraform.tfvars."
  sensitive   = true
  default     = null
}

variable "redis_node_type" {
  type        = string
  description = "ElastiCache node type."
  default     = "cache.t3.micro"
}

variable "domain_name" {
  type        = string
  description = "Public hostname for ACM + ALB (e.g. app.example.com). Empty skips HTTPS."
  default     = ""
}

variable "route53_zone_id" {
  type        = string
  description = "Optional hosted zone for ACM DNS validation. Empty = output records only."
  default     = ""
}

variable "enable_nat_gateway" {
  type        = bool
  description = "Create a NAT gateway so private subnets can reach the internet."
  default     = true
}
