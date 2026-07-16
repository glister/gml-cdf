variable "project" { type = string }
variable "environment" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

variable "log_analytics_workspace_id" { type = string }
variable "identity_id" { type = string }
variable "acr_login_server" { type = string }
variable "image_tag" { type = string }
variable "min_replicas" { type = number }
variable "max_replicas" { type = number }

# Versionless Key Vault secret ids, keyed by secret name.
variable "secret_ids" {
  type = map(string)
}

# Plain (non-secret) config.
variable "postgres_host" { type = string }
variable "postgres_user" { type = string }
variable "postgres_port" { type = number }
variable "postgres_db" { type = string }
variable "app_url" { type = string }
variable "api_url" { type = string }
variable "email_from" { type = string }
variable "storage_container" { type = string }
variable "trusted_origins" { type = string }
variable "service_bus_namespace_name" { type = string }
variable "log_level" {
  type    = string
  default = "info"
}
