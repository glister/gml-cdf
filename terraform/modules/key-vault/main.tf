variable "project" { type = string }
variable "environment" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "tenant_id" { type = string }
variable "secrets" {
  description = "Map of secret name => value to store."
  type        = map(string)
  sensitive   = true
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_key_vault" "this" {
  name                       = "${var.project}-${var.environment}-kv"
  resource_group_name        = var.resource_group_name
  location                   = var.location
  tenant_id                  = var.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
  tags                       = var.tags
}

resource "azurerm_key_vault_secret" "secrets" {
  # Secret names are not sensitive (only their values are), so declassify the
  # keys for use as for_each identifiers.
  for_each     = nonsensitive(toset(keys(var.secrets)))
  name         = each.value
  value        = var.secrets[each.value]
  key_vault_id = azurerm_key_vault.this.id
}

output "id" {
  value = azurerm_key_vault.this.id
}

output "uri" {
  value = azurerm_key_vault.this.vault_uri
}

# Versionless secret ids, keyed by secret name — for Container App secret refs.
output "secret_ids" {
  value = { for k, s in azurerm_key_vault_secret.secrets : k => s.versionless_id }
}
