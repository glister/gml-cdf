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

# --- Custom domains (runbook §11) ---
# DNS stays at Krystal and is created by hand. Leave false until the records
# from `terraform output dns_records_required` exist and resolve, then flip.
enable_custom_domains = false
