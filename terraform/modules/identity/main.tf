variable "project" { type = string }
variable "environment" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "acr_id" { type = string }
variable "key_vault_id" { type = string }
variable "service_bus_namespace_id" { type = string }
variable "storage_account_id" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

# One user-assigned identity shared by the Container Apps, with least-privilege
# role assignments (ACR pull, KV secrets read, Service Bus, Storage blobs).
resource "azurerm_user_assigned_identity" "app" {
  name                = "${var.project}-${var.environment}-app-id"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "kv_secrets_user" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "service_bus" {
  scope                = var.service_bus_namespace_id
  role_definition_name = "Azure Service Bus Data Owner"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "storage_blob" {
  scope                = var.storage_account_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

output "id" {
  value = azurerm_user_assigned_identity.app.id
}

output "principal_id" {
  value = azurerm_user_assigned_identity.app.principal_id
}

output "client_id" {
  value = azurerm_user_assigned_identity.app.client_id
}
