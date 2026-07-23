locals {
  tags = {
    project     = var.project
    environment = var.environment
    managed_by  = "terraform"
  }
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
  # plans/modules add their own). The hello-world queue stays until plan 07
  # replaces it with the effects queue. These replace the module's placeholder
  # events/events-sub defaults.
  queues        = ["hello-world"]
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
