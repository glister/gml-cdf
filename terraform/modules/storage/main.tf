variable "project" { type = string }
variable "environment" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "container_name" {
  type    = string
  default = "uploads"
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_storage_account" "this" {
  name                     = replace("${var.project}${var.environment}stor", "-", "")
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = var.tags
}

resource "azurerm_storage_container" "uploads" {
  name                  = var.container_name
  storage_account_name  = azurerm_storage_account.this.name
  container_access_type = "private"
}

output "id" {
  value = azurerm_storage_account.this.id
}

output "name" {
  value = azurerm_storage_account.this.name
}

output "container_name" {
  value = azurerm_storage_container.uploads.name
}

output "primary_connection_string" {
  value     = azurerm_storage_account.this.primary_connection_string
  sensitive = true
}
