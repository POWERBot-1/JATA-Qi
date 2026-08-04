# Outputs for downstream consumption (kubectl, helm, app config).

output "cluster_name" {
  value       = module.eks.cluster_name
  description = "EKS cluster name."
}

output "cluster_endpoint" {
  value       = module.eks.cluster_endpoint
  description = "EKS API server endpoint."
}

output "cluster_certificate_authority_data" {
  value       = module.eks.cluster_certificate_authority_data
  sensitive   = true
  description = "EKS CA certificate (base64)."
}

output "database_endpoint" {
  value       = aws_db_instance.jataqi.endpoint
  description = "RDS PostgreSQL endpoint (host:port)."
}

output "database_name" {
  value       = aws_db_instance.jataqi.db_name
  description = "PostgreSQL database name."
}

output "database_username" {
  value       = aws_db_instance.jataqi.username
  description = "PostgreSQL master username."
}

output "backup_bucket" {
  value       = aws_s3_bucket.backups.bucket
  description = "S3 backup bucket name."
}

output "secrets_arn" {
  value       = aws_secretsmanager_secret.app_secrets.arn
  description = "Secrets Manager ARN for application secrets."
}
