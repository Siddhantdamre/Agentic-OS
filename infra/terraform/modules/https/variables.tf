variable "name_prefix" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "domain_name" {
  type = string
}

variable "route53_zone_id" {
  type    = string
  default = ""
}

variable "app_port" {
  type        = number
  default     = 3000
  description = "Dashboard port the ALB forwards to (matches compose :3000)."
}
