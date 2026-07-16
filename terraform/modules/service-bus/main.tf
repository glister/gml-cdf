variable "project" { type = string }
variable "environment" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "queues" {
  type    = list(string)
  default = ["hello-world"]
}
variable "topics" {
  type    = list(string)
  default = ["events"]
}
variable "subscriptions" {
  description = "Map of subscription name => topic name."
  type        = map(string)
  default     = { "events-sub" = "events" }
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_servicebus_namespace" "this" {
  name                = "${var.project}-${var.environment}-sb"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_servicebus_queue" "queues" {
  for_each     = toset(var.queues)
  name         = each.value
  namespace_id = azurerm_servicebus_namespace.this.id
}

resource "azurerm_servicebus_topic" "topics" {
  for_each     = toset(var.topics)
  name         = each.value
  namespace_id = azurerm_servicebus_namespace.this.id
}

resource "azurerm_servicebus_subscription" "subs" {
  for_each           = var.subscriptions
  name               = each.key
  topic_id           = azurerm_servicebus_topic.topics[each.value].id
  max_delivery_count = 10
}

output "namespace_id" {
  value = azurerm_servicebus_namespace.this.id
}

output "namespace_name" {
  value = azurerm_servicebus_namespace.this.name
}

output "primary_connection_string" {
  value     = azurerm_servicebus_namespace.this.default_primary_connection_string
  sensitive = true
}
