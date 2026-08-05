variable "subscription_id" {
  description = "Azure subscription id (also passed as ARM_SUBSCRIPTION_ID in CI)."
  type        = string
}

variable "project" {
  description = <<-DESC
    Short project name used as a resource-name prefix. Modules that build
    alphanumeric-only names (ACR, Storage) strip the hyphen via `replace()`, so
    `cdf-connect` yields `cdfconnect<env>acr` / `cdfconnect<env>stor`. Anything
    deriving a resource name outside Terraform must strip it the same way —
    see `.github/workflows/build-and-push.yml`.
  DESC
  type        = string
  default     = "cdf-connect"
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
  # UK region: employee HR data, including special-category data, stays in the UK
  # (ADR-0019). `uksouth` over `ukwest` — ukwest has no availability zones, and
  # the postgres module pins `zone = "1"`.
  description = "Azure region."
  type        = string
  default     = "uksouth"
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
  default = "cdfconnectadmin"
}

variable "postgres_admin_password" {
  description = "Postgres admin password (TF_VAR_postgres_admin_password in CI)."
  type        = string
  sensitive   = true
}

variable "database_name" {
  # Underscore, not hyphen: a hyphenated Postgres identifier needs quoting
  # everywhere it appears (psql, connection strings, migrations).
  type    = string
  default = "cdf_connect"
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

# --- Custom domains ---

variable "dns_parent_zone" {
  description = <<-DESC
    The DNS zone the records live in, hosted at Krystal. Used only to render
    `dns_records_required` with hosts relative to the zone, which is how
    Krystal's panel expects them. Not derived from app_url: `.co.uk` is a
    two-label public suffix, so no amount of splitting on dots gets this right.
  DESC
  type        = string
  default     = "cdfencing.co.uk"
}

variable "enable_custom_domains" {
  description = <<-DESC
    Issue managed certificates for `app_url`/`api_url` and bind them to the
    apps. DNS is not managed by Terraform — it lives at Krystal. Leave false
    until the CNAME and asuid TXT records from `terraform output
    dns_records_required` exist and resolve; enabling early fails certificate
    validation. See runbook §11.
  DESC
  type        = bool
  default     = false
}
