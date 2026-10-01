variable "name_prefix" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "azs" {
  type        = list(string)
  description = "Exactly two availability zones."
}

variable "enable_nat_gateway" {
  type    = bool
  default = true
}
