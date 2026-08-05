locals {
  tags = {
    project     = var.project
    environment = var.environment
    managed_by  = "terraform"
  }

  # Hostnames are derived from the URLs the app is configured with rather than
  # declared separately, so the certificate can only ever be issued for the name
  # the app actually answers to.
  web_hostname = replace(replace(var.app_url, "https://", ""), "/", "")
  api_hostname = replace(replace(var.api_url, "https://", ""), "/", "")
}

resource "azurerm_resource_group" "this" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

module "acr" {
  source              = "./modules/container-registry"
  project             = var.project
  environment         = var.environment
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.tags
}

module "observability" {
  source              = "./modules/observability"
  project             = var.project
  environment         = var.environment
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.tags
}

module "storage" {
  source              = "./modules/storage"
  project             = var.project
  environment         = var.environment
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.tags
}

module "service_bus" {
  source              = "./modules/service-bus"
  project             = var.project
  environment         = var.environment
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location

  # The domain-event journal relay (core plan 02 §5.2) publishes to the
  # domain-events topic; Phase 1 has the single pilot-demo subscription (later
  # plans/modules add their own). The `effects` queue carries scheduled command
  # messages (core plan 03 §5.2 — the identity sweeps); plan 07's scheduled-action
  # mechanism will own it later, but this plan lands it now (see §5.2 sequencing).
  queues        = ["hello-world", "effects"]
  topics        = ["domain-events"]
  subscriptions = { "pilot-demo" = "domain-events" }

  tags = local.tags
}

module "postgres" {
  source              = "./modules/postgres"
  project             = var.project
  environment         = var.environment
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku_name            = var.postgres_sku_name
  storage_mb          = var.postgres_storage_mb
  postgres_version    = var.postgres_version
  admin_login         = var.postgres_admin_login
  admin_password      = var.postgres_admin_password
  database_name       = var.database_name
  tags                = local.tags
}

module "key_vault" {
  source              = "./modules/key-vault"
  project             = var.project
  environment         = var.environment
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  tags                = local.tags

  secrets = {
    "resend-api-key"                = var.resend_api_key
    "better-auth-secret"            = var.better_auth_secret
    "postgres-password"             = var.postgres_admin_password
    "service-bus-connection-string" = module.service_bus.primary_connection_string
    "storage-connection-string"     = module.storage.primary_connection_string
  }
}

module "identity" {
  source                   = "./modules/identity"
  project                  = var.project
  environment              = var.environment
  resource_group_name      = azurerm_resource_group.this.name
  location                 = azurerm_resource_group.this.location
  acr_id                   = module.acr.id
  key_vault_id             = module.key_vault.id
  service_bus_namespace_id = module.service_bus.namespace_id
  storage_account_id       = module.storage.id
  tags                     = local.tags
}

module "container_apps" {
  source                     = "./modules/container-apps"
  project                    = var.project
  environment                = var.environment
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  log_analytics_workspace_id = module.observability.id
  identity_id                = module.identity.id
  acr_login_server           = module.acr.login_server
  image_tag                  = var.image_tag
  min_replicas               = var.min_replicas
  max_replicas               = var.max_replicas
  secret_ids                 = module.key_vault.secret_ids

  postgres_host              = module.postgres.fqdn
  postgres_user              = var.postgres_admin_login
  postgres_port              = 5432
  postgres_db                = module.postgres.database_name
  app_url                    = var.app_url
  api_url                    = var.api_url
  email_from                 = var.email_from
  storage_container          = module.storage.container_name
  trusted_origins            = "${var.app_url},${var.api_url}"
  service_bus_namespace_name = module.service_bus.namespace_name
  log_level                  = "info"

  tags = local.tags
}

# Custom domains. Gated on `dns_zone_name` so an environment without a delegated
# zone still applies cleanly and keeps its generated *.azurecontainerapps.io
# hostnames. The hostnames come from app_url/api_url so there is one source of
# truth: what the app believes it is called is what gets bound and certificated.
module "dns_and_certs" {
  source = "./modules/dns-and-certs"
  count  = var.dns_zone_name == "" ? 0 : 1

  dns_zone_name                       = var.dns_zone_name
  resource_group_name                 = azurerm_resource_group.this.name
  container_app_environment_id        = module.container_apps.environment_id
  container_app_environment_static_ip = module.container_apps.environment_static_ip
  enable_bindings                     = var.enable_custom_domain_bindings
  tags                                = local.tags

  bindings = {
    web = {
      container_app_id = module.container_apps.web_id
      hostname         = local.web_hostname
      ingress_fqdn     = module.container_apps.web_fqdn
      verification_id  = module.container_apps.web_custom_domain_verification_id
    }
    api = {
      container_app_id = module.container_apps.api_id
      hostname         = local.api_hostname
      ingress_fqdn     = module.container_apps.api_fqdn
      verification_id  = module.container_apps.api_custom_domain_verification_id
    }
  }
}
