# Input variables for the JATA Qi Terraform configuration.

variable "project_name" {
  type        = string
  default     = "jataqi"
  description = "Project name prefix for all resources."
}

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region for all resources."
}

variable "kubernetes_version" {
  type        = string
  default     = "1.30"
  description = "EKS Kubernetes version."
}

variable "node_instance_type" {
  type        = string
  default     = "t3.medium"
  description = "EKS node instance type."
}

variable "node_min_size"     { type = number, default = 1 }
variable "node_max_size"     { type = number, default = 4 }
variable "node_desired_size" { type = number, default = 2 }

variable "single_nat_gateway" {
  type        = bool
  default     = true
  description = "Use a single NAT gateway (cost optimization for dev/staging)."
}

variable "postgres_version" {
  type        = string
  default     = "16"
  description = "PostgreSQL engine version."
}

variable "db_instance_class" {
  type        = string
  default     = "db.t3.micro"
  description = "RDS instance class."
}

variable "db_storage_gb" {
  type        = number
  default     = 20
  description = "Allocated storage in GB."
}

variable "db_name" {
  type        = string
  default     = "jataqi"
  description = "PostgreSQL database name."
}

variable "db_username" {
  type        = string
  default     = "jataqi"
  description = "PostgreSQL master username."
}

variable "db_multi_az" {
  type        = bool
  default     = false
  description = "Enable Multi-AZ for high availability."
}

variable "db_backup_retention_days" {
  type        = number
  default     = 14
  description = "Automated backup retention (days)."
}

variable "backup_retention_days" {
  type        = number
  default     = 30
  description = "S3 backup object expiration (days)."
}

variable "skip_final_snapshot" {
  type        = bool
  default     = false
  description = "Skip final RDS snapshot on destroy (set true for dev)."
}
