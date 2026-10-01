variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "db_master_password" {
  type      = string
  sensitive = true
  default   = null
}

variable "app_db_password" {
  type      = string
  sensitive = true
  default   = null
}
