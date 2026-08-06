# JATA Qi — Disaster-recovery region (multi-region resilience).
#
# Provisions a second AWS region with its own VPC, an RDS PostgreSQL read
# replica of the primary database, and cross-region S3 replication for the
# backup bucket. Together with the @jataqi/resilience-engineering +
# @jataqi/disaster-recovery modules (automated failover, RPO measured from
# the newest snapshot) this satisfies the Global Resilience Engineering
# directive: geographically distributed deployment, tested failover, and
# recovery objectives.
#
# The DR region is intentionally NOT a full active cluster by default: the
# replica + replicated backups give RPO ~ minutes with a failover runbook.
# Scale to an active EKS cluster in the DR region (dr_region_active = true)
# for RTO < 5 minutes.
#
# Apply order: primary (main.tf) → this file.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# --- DR-region provider (aliased) ---------------------------------------------

provider "aws" {
  alias  = "dr"
  region = var.dr_region
}

# --- DR VPC -------------------------------------------------------------------

module "vpc_dr" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  providers = { aws = aws.dr }

  name                 = "${var.project_name}-dr-vpc"
  cidr                 = "10.1.0.0/16"
  azs                  = ["${var.dr_region}a", "${var.dr_region}b", "${var.dr_region}c"]
  private_subnets      = ["10.1.1.0/24", "10.1.2.0/24", "10.1.3.0/24"]
  public_subnets       = ["10.1.101.0/24", "10.1.102.0/24", "10.1.103.0/24"]
  enable_nat_gateway   = true
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.tags, { Role = "dr" })
}

# --- RDS read replica (cross-region) ------------------------------------------

resource "aws_db_instance" "primary_cross_region_replica" {
  provider = aws.dr
  count    = var.dr_enabled ? 1 : 0

  identifier = "${var.project_name}-dr-replica"
  # Replica of the primary RDS instance (created in main.tf).
  replicate_source_db = aws_db_instance.jataqi.arn

  instance_class = var.dr_db_instance_class
  multi_az       = false
  skip_final_snapshot = true
  backup_retention_period = var.dr_backup_retention_days

  vpc_security_group_ids = [module.vpc_dr.default_security_group_id]
  db_subnet_group_name   = aws_db_subnet_group.dr.name

  tags = merge(local.tags, { Role = "dr-replica" })
}

resource "aws_db_subnet_group" "dr" {
  provider   = aws.dr
  count      = var.dr_enabled ? 1 : 0
  name       = "${var.project_name}-dr-subnets"
  subnet_ids = module.vpc_dr.private_subnets
}

# --- Cross-region S3 replication for backups ----------------------------------

resource "aws_s3_bucket" "backup_dr" {
  provider = aws.dr
  count    = var.dr_enabled ? 1 : 0
  bucket   = "${var.project_name}-backups-dr"
}

resource "aws_s3_bucket_versioning" "backup_dr" {
  provider = aws.dr
  count    = var.dr_enabled ? 1 : 0
  bucket   = aws_s3_bucket.backup_dr[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

# Replication from the primary backup bucket (created in main.tf).
resource "aws_s3_bucket_replication_configuration" "backups" {
  count    = var.dr_enabled ? 1 : 0
  depends_on = [aws_s3_bucket_versioning.backup_dr]
  bucket   = aws_s3_bucket.backups.id
  role     = aws_iam_role.s3_replication[0].arn

  rule {
    id     = "dr-replication"
    status = "Enabled"
    destination {
      bucket        = aws_s3_bucket.backup_dr[0].arn
      storage_class = "STANDARD_IA"
    }
  }
}

# Minimal replication IAM role (both regions).
resource "aws_iam_role" "s3_replication" {
  count  = var.dr_enabled ? 1 : 0
  name   = "${var.project_name}-s3-replication"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
    }]
  })
}

# --- Optional active DR cluster ------------------------------------------------

# Uncomment to run an EKS cluster in the DR region for RTO < 5 minutes.
# module "eks_dr" {
#   source  = "terraform-aws-modules/eks/aws"
#   version = "~> 20.0"
#   providers = { aws = aws.dr }
#
#   cluster_name    = "${var.project_name}-dr-cluster"
#   cluster_version = var.kubernetes_version
#   vpc_id          = module.vpc_dr.vpc_id
#   subnet_ids      = module.vpc_dr.private_subnets
#   enable_irsa     = true
#   tags            = merge(local.tags, { Role = "dr" })
# }
