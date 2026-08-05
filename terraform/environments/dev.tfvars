environment         = "dev"
location            = "uksouth"
resource_group_name = "cdf-connect-dev-rg"
project             = "cdf-connect"

postgres_sku_name   = "B_Standard_B1ms"
postgres_storage_mb = 32768
postgres_version    = "16"

image_tag    = "latest"
min_replicas = 1
max_replicas = 2

# See prod.tfvars: api_url must stay same-site with app_url for session cookies.
email_from = "noreply@dev.connect.cdfencing.co.uk"
app_url    = "https://dev.connect.cdfencing.co.uk"
api_url    = "https://api.dev.connect.cdfencing.co.uk"

# Sensitive values (subscription_id, postgres_admin_password, resend_api_key,
# better_auth_secret) come from TF_VAR_* in CI.

# --- Custom domains (runbook §11) --- see prod.tfvars for the two-phase rollout.
dns_zone_name                 = "dev.connect.cdfencing.co.uk"
enable_custom_domain_bindings = false
