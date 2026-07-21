environment         = "prod"
location            = "eastus"
resource_group_name = "cdf-prod-rg"
project             = "cdf"

postgres_sku_name   = "GP_Standard_D2s_v3"
postgres_storage_mb = 131072
postgres_version    = "16"

image_tag    = "latest"
min_replicas = 2
max_replicas = 5

email_from = "noreply@cdf.example"
app_url    = "https://app.cdf.example"
api_url    = "https://api.cdf.example"

# Sensitive values (subscription_id, postgres_admin_password, resend_api_key,
# better_auth_secret) come from TF_VAR_* in CI.
