# JATA Qi — Terraform infrastructure (AWS).
# Provisions an EKS cluster, RDS PostgreSQL (multi-writer storage, PR8),
# and an S3 backup bucket. Deploy with: terraform init && terraform apply.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket         = "jataqi-tfstate"
    key            = "jataqi/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "jataqi-tflocks"
  }
}

provider "aws" {
  region = var.aws_region
}

# --- VPC ---------------------------------------------------------------------

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name                 = "${var.project_name}-vpc"
  cidr                 = "10.0.0.0/16"
  azs                  = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]
  private_subnets      = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets       = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
  enable_nat_gateway   = true
  single_nat_gateway   = var.single_nat_gateway
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = local.tags
}

# --- EKS Cluster -------------------------------------------------------------

module "eks" {
  source = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "${var.project_name}-cluster"
  cluster_version = var.kubernetes_version

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnets
  cluster_endpoint_public  = true
  cluster_endpoint_private = true

  enable_irsa = true

  eks_managed_node_groups = {
    main = {
      min_size       = var.node_min_size
      max_size       = var.node_max_size
      desired_size   = var.node_desired_size
      instance_types = [var.node_instance_type]
      disk_size      = 50
    }
  }

  tags = local.tags
}

# --- RDS PostgreSQL (multi-writer storage, PR8) ------------------------------

resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "jataqi" {
  name       = "${var.project_name}-db-subnet-group"
  subnet_ids = module.vpc.private_subnets
  tags       = local.tags
}

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds-sg"
  description = "Allow PostgreSQL access from EKS nodes"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "PostgreSQL from EKS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_db_instance" "jataqi" {
  identifier             = "${var.project_name}-db"
  engine                 = "postgres"
  engine_version         = var.postgres_version
  instance_class         = var.db_instance_class
  allocated_storage      = var.db_storage_gb
  storage_encrypted      = true

  db_name                = var.db_name
  username               = var.db_username
  password               = random_password.db_password.result

  db_subnet_group_name   = aws_db_subnet_group.jataqi.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  skip_final_snapshot    = var.skip_final_snapshot
  backup_retention_period = var.db_backup_retention_days
  multi_az               = var.db_multi_az

  tags = local.tags
}

# --- S3 Backup Bucket (disaster recovery) ------------------------------------

resource "aws_s3_bucket" "backups" {
  bucket = "${var.project_name}-backups"
  tags   = local.tags
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    expiration { days = var.backup_retention_days }
  }
}

# --- Secrets (Stripe, SendGrid, etc.) ----------------------------------------

resource "aws_secretsmanager_secret" "app_secrets" {
  name        = "${var.project_name}/app"
  description = "Application secrets (Stripe, SendGrid, Twilio, etc.)"
  tags        = local.tags
}
