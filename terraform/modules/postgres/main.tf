variable "project" { type = string }
variable "environment" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "sku_name" { type = string }
variable "storage_mb" { type = number }
variable "postgres_version" { type = string }
variable "admin_login" { type = string }
variable "admin_password" {
  type      = string
  sensitive = true
}
variable "database_name" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "${var.project}-${var.environment}-pg"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  version                       = var.postgres_version
  administrator_login           = var.admin_login
  administrator_password        = var.admin_password
  sku_name                      = var.sku_name
  storage_mb                    = var.storage_mb
  zone                          = "1"
  public_network_access_enabled = true
  tags                          = var.tags
}

resource "azurerm_postgresql_flexible_server_database" "this" {
  name      = var.database_name
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# Extension allow-list (core plan 05 §12.1/§12.3).
#
# Azure Database for PostgreSQL Flexible Server refuses `CREATE EXTENSION` for
# anything not named in the `azure.extensions` server parameter, regardless of
# role. `btree_gist` is required by core plan 05's migration — it backs the
# `team_membership_no_overlap` EXCLUDE constraint, which is how the
# "one membership per person per team at a time" invariant is a database
# property rather than an application promise (ADR-0011).
#
# Without this, `20260803T100100-platform-team` fails on the first deploy to a
# fresh server. Names are uppercase and comma-separated; append rather than
# replace when a later plan needs another extension.
resource "azurerm_postgresql_flexible_server_configuration" "azure_extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = "BTREE_GIST"
}

# Allow other Azure services (e.g. Container Apps) to reach the server.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.this.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

output "fqdn" {
  value = azurerm_postgresql_flexible_server.this.fqdn
}

output "server_name" {
  value = azurerm_postgresql_flexible_server.this.name
}

output "database_name" {
  value = azurerm_postgresql_flexible_server_database.this.name
}
