locals {
  # env var name => KV secret name
  secret_env = {
    POSTGRES_PASSWORD               = "postgres-password"
    BETTER_AUTH_SECRET              = "better-auth-secret"
    RESEND_API_KEY                  = "resend-api-key"
    SERVICE_BUS_CONNECTION_STRING   = "service-bus-connection-string"
    AZURE_STORAGE_CONNECTION_STRING = "storage-connection-string"
  }

  # Container App `secret` blocks (name => KV secret id).
  app_secrets = {
    for env_name, secret_name in local.secret_env :
    secret_name => var.secret_ids[secret_name]
  }

  common_env = {
    NODE_ENV                    = "production"
    LOG_LEVEL                   = var.log_level
    POSTGRES_HOST               = var.postgres_host
    POSTGRES_USER               = var.postgres_user
    POSTGRES_PORT               = tostring(var.postgres_port)
    POSTGRES_DB                 = var.postgres_db
    APP_URL                     = var.app_url
    BETTER_AUTH_URL             = var.api_url
    BETTER_AUTH_TRUSTED_ORIGINS = var.trusted_origins
    EMAIL_FROM                  = var.email_from
    AZURE_STORAGE_CONTAINER     = var.storage_container
    VITE_API_URL                = var.api_url
    API_INTERNAL_URL            = var.api_url
  }
}

resource "azurerm_container_app_environment" "this" {
  name                       = "${var.project}-${var.environment}-cae"
  resource_group_name        = var.resource_group_name
  location                   = var.location
  log_analytics_workspace_id = var.log_analytics_workspace_id
  tags                       = var.tags
}

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "api" {
  name                         = "${var.project}-${var.environment}-api"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  registry {
    server   = var.acr_login_server
    identity = var.identity_id
  }

  dynamic "secret" {
    for_each = local.app_secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = var.identity_id
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3001
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "api"
      image  = "${var.acr_login_server}/api:${var.image_tag}"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT_API"
        value = "3001"
      }
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }
  }
}

# ---------------------------------------------------------------------------
# WEB (SSR) — talks to the API over HTTP; no DB/queue secrets needed.
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "web" {
  name                         = "${var.project}-${var.environment}-web"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  registry {
    server   = var.acr_login_server
    identity = var.identity_id
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "web"
      image  = "${var.acr_login_server}/web:${var.image_tag}"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = "3000"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "LOG_LEVEL"
        value = var.log_level
      }
      env {
        name  = "VITE_API_URL"
        value = var.api_url
      }
      env {
        name  = "API_INTERNAL_URL"
        value = var.api_url
      }
    }
  }
}

# ---------------------------------------------------------------------------
# WORKER — no ingress; scales on the Service Bus queue depth (KEDA).
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "worker" {
  name                         = "${var.project}-${var.environment}-worker"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  registry {
    server   = var.acr_login_server
    identity = var.identity_id
  }

  dynamic "secret" {
    for_each = local.app_secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = var.identity_id
    }
  }

  template {
    # The outbox relay (core plan 02 §5.2) is a poller, not a queue-triggered
    # handler, so the worker cannot scale to zero — it must always be running to
    # publish journalled events. KEDA still scales it UP on subscription depth.
    min_replicas = 1
    max_replicas = var.max_replicas

    container {
      name   = "worker"
      image  = "${var.acr_login_server}/worker:${var.image_tag}"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT_WORKER"
        value = "3002"
      }
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }

    custom_scale_rule {
      name             = "servicebus-hello-world"
      custom_rule_type = "azure-servicebus"
      metadata = {
        queueName    = "hello-world"
        namespace    = var.service_bus_namespace_name
        messageCount = "5"
      }
      authentication {
        secret_name       = "service-bus-connection-string"
        trigger_parameter = "connection"
      }
    }
  }
}

output "api_fqdn" {
  value = azurerm_container_app.api.ingress[0].fqdn
}

output "web_fqdn" {
  value = azurerm_container_app.web.ingress[0].fqdn
}
