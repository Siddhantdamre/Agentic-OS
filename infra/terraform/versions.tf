terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Default: local state (gitignored). For remote state:
  #   terraform init -backend-config=backend.hcl
  # See backend.hcl.example. Do not put credentials in this file.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.name_prefix
      Environment = var.environment
      ManagedBy   = "terraform"
      Workstream  = "WS-23"
    }
  }
}
