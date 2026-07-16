variable "subscription_id" {
  description = "Azure subscription id (also passed as ARM_SUBSCRIPTION_ID in CI)."
  type        = string
}

variable "project" {
  description = "Short project name used as a resource-name prefix."
  type        = string
  default     = "cdf"
}

variable "environment" {
  description = "Deployment environment (dev | prod)."
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be one of: dev, prod."
  }
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus"
}

variable "resource_group_name" {
  description = "Resource group to create/use for this environment."
  type        = string
}

# --- Postgres ---
variable "postgres_sku_name" {
  description = "Flexible Server SKU."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  type    = number
  default = 32768
}

variable "postgres_version" {
  type    = string
  default = "16"
}

variable "postgres_admin_login" {
  type    = string
  default = "cdfadmin"
}

variable "postgres_admin_password" {
  description = "Postgres admin password (TF_VAR_postgres_admin_password in CI)."
  type        = string
  sensitive   = true
}

variable "database_name" {
  type    = string
  default = "cdf"
}

# --- Container images ---
variable "image_tag" {
  description = "Image tag deployed to the Container Apps (set by build-and-push CI)."
  type        = string
  default     = "latest"
}

# --- App secrets (populated into Key Vault) ---
variable "resend_api_key" {
  type      = string
  sensitive = true
}

variable "better_auth_secret" {
  type      = string
  sensitive = true
}

variable "internal_service_token" {
  type      = string
  sensitive = true
}

# --- App config ---
variable "email_from" {
  description = "From address for transactional email."
  type        = string
  default     = "noreply@example.com"
}

variable "app_url" {
  description = "Public URL of the web app (for CORS / better-auth trusted origins)."
  type        = string
}

variable "api_url" {
  description = "Public URL of the API."
  type        = string
}

variable "min_replicas" {
  type    = number
  default = 1
}

variable "max_replicas" {
  type    = number
  default = 3
}
