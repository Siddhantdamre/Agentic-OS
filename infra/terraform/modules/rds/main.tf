resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-rds"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "${var.name_prefix}-rds"
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "Postgres 5432 from the app security group only."
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name_prefix}-rds"
  }
}

resource "aws_db_instance" "this" {
  count = var.db_master_password != null ? 1 : 0

  identifier     = "${var.name_prefix}-pg"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  db_name  = var.db_name
  username = var.db_master_username
  password = var.db_master_password

  allocated_storage     = var.allocated_storage
  max_allocated_storage = 100
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period = var.backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"
  deletion_protection     = true
  skip_final_snapshot     = false
  final_snapshot_identifier = "${var.name_prefix}-pg-final"

  # pgvector is available on RDS Postgres 16. Enable after apply:
  #   CREATE EXTENSION IF NOT EXISTS vector;
  apply_immediately = false

  tags = {
    Name = "${var.name_prefix}-pg"
  }
}
