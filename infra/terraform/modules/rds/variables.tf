variable "name_prefix" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "db_name" {
  type = string
}

variable "db_instance_class" {
  type = string
}

variable "db_master_username" {
  type = string
}

variable "db_master_password" {
  type        = string
  sensitive   = true
  default     = null
  description = "From root tfvars. Null skips instance creation (plan-only skeleton)."
}

variable "allocated_storage" {
  type    = number
  default = 20
}

variable "backup_retention_days" {
  type        = number
  default     = 7
  description = "Automated backups. Restore drill is wave 2 (modules/backups)."
}
