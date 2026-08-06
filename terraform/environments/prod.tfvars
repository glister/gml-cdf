environment         = "prod"
location            = "uksouth"
resource_group_name = "cdf-connect-prod-rg"
project             = "cdf-connect"

postgres_sku_name   = "GP_Standard_D2s_v3"
postgres_storage_mb = 131072
postgres_version    = "16"

image_tag    = "latest"
min_replicas = 2
max_replicas = 5

# api_url stays a subdomain of app_url's registrable domain (cdfencing.co.uk) so
# the two are same-site: Better Auth uses default SameSite=Lax cookies, which the
# browser would drop on the web app's credentialed cross-site calls otherwise.
email_from = "noreply@connect.cdfencing.co.uk"
app_url    = "https://connect.cdfencing.co.uk"
api_url    = "https://api.connect.cdfencing.co.uk"

# Sensitive values (subscription_id, postgres_admin_password, resend_api_key,
# better_auth_secret) come from TF_VAR_* in CI.

# --- Custom domains (runbook §11) ---
# DNS stays at Krystal and is created by hand. Leave false until the records
# from `terraform output dns_records_required` exist and resolve, then flip.
enable_custom_domains = false
