data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs          = slice(data.aws_availability_zones.available.names, 0, 2)
  enable_https = var.domain_name != ""
}

module "vpc" {
  source = "./modules/vpc"

  name_prefix        = var.name_prefix
  vpc_cidr           = var.vpc_cidr
  azs                = local.azs
  enable_nat_gateway = var.enable_nat_gateway
}

module "secrets" {
  source = "./modules/secrets"

  name_prefix        = var.name_prefix
  environment        = var.environment
  db_master_password = var.db_master_password
  app_db_password    = var.app_db_password
}

module "rds" {
  source = "./modules/rds"

  name_prefix          = var.name_prefix
  vpc_id               = module.vpc.vpc_id
  private_subnet_ids   = module.vpc.private_subnet_ids
  app_security_group_id = module.vpc.app_security_group_id
  db_name              = var.db_name
  db_instance_class    = var.db_instance_class
  db_master_username   = var.db_master_username
  db_master_password   = var.db_master_password
}

module "redis" {
  source = "./modules/redis"

  name_prefix           = var.name_prefix
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  app_security_group_id = module.vpc.app_security_group_id
  node_type             = var.redis_node_type
}

module "https" {
  count  = local.enable_https ? 1 : 0
  source = "./modules/https"

  name_prefix           = var.name_prefix
  vpc_id                = module.vpc.vpc_id
  public_subnet_ids     = module.vpc.public_subnet_ids
  app_security_group_id = module.vpc.app_security_group_id
  domain_name           = var.domain_name
  route53_zone_id       = var.route53_zone_id
}
