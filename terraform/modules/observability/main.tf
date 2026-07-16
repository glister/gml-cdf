variable "project" { type = string }
variable "environment" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.project}-${var.environment}-law"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

output "id" {
  value = azurerm_log_analytics_workspace.this.id
}

output "workspace_id" {
  value = azurerm_log_analytics_workspace.this.workspace_id
}
