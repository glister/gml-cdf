environment         = "dev"
location            = "eastus"
resource_group_name = "cdf-dev-rg"
project             = "cdf"

postgres_sku_name   = "B_Standard_B1ms"
postgres_storage_mb = 32768
postgres_version    = "16"

image_tag    = "latest"
min_replicas = 1
max_replicas = 2

email_from = "noreply@dev.cdf.example"
app_url    = "https://cdf-dev-web.example.com"
api_url    = "https://cdf-dev-api.example.com"

# Sensitive values (subscription_id, postgres_admin_password, resend_api_key,
# better_auth_secret) come from TF_VAR_* in CI.
