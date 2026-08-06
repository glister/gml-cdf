variable "project" { type = string }
variable "environment" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "queues" {
  type    = list(string)
  default = ["hello-world"]
}
variable "duplicate_detection_queues" {
  description = <<-EOT
    Queues with Service Bus duplicate detection enabled, mapped to their history
    window (ISO-8601 duration). The `effects` queue uses it as the FIRST
    idempotency layer for effect messages, whose MessageIds are deterministic
    (core plan 07 §5.4) — the real guarantee is each handler's own idempotency,
    because this window expires and duplicates can arrive after it.

    Changing this on an existing queue REPLACES it: Service Bus cannot toggle
    duplicate detection in place. Draining before an apply avoids losing
    in-flight messages.
  EOT
  type        = map(string)
  default     = {}
}
variable "dead_letter_alert_threshold" {
  description = "Dead-letter message count on the effects queue that raises an alert. A poison effect is a build defect, so the useful threshold is 'any' (core plan 07 §5.4)."
  type        = number
  default     = 1
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

  # A handler that throws abandons the message; Service Bus redelivers with its
  # default backoff and dead-letters after this many attempts (core plan 07
  # §5.4). Explicit because the retry budget is a design decision, not a default
  # to be discovered.
  max_delivery_count = 10

  requires_duplicate_detection            = contains(keys(var.duplicate_detection_queues), each.value)
  duplicate_detection_history_time_window = lookup(var.duplicate_detection_queues, each.value, "PT10M")
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

# DEAD-LETTER ALERT — the effects queue's poison signal (core plan 07 §5.4).
#
# Each effect is its own message, so one poison effect dead-letters without
# blocking its siblings — which is exactly why nobody would notice it from
# throughput alone. An unknown effect name dead-letters on first delivery, so any
# non-zero depth here means a handler was never registered or a payload is
# malformed: a build defect, not an operational blip. Hence a threshold of 1.
#
# No `action` block yet: the recipient (email list, Teams webhook, on-call) is a
# CDF decision, tracked as core plan 07 §12.2 Q5. The rule fires and is visible
# in Azure Monitor meanwhile; adding an action group is a one-block change.
resource "azurerm_monitor_metric_alert" "effects_dead_letter" {
  count = contains(var.queues, "effects") ? 1 : 0

  name                = "${var.project}-${var.environment}-effects-dlq"
  resource_group_name = var.resource_group_name
  scopes              = [azurerm_servicebus_namespace.this.id]
  description         = "Messages have dead-lettered on the effects queue — an unregistered effect handler or a malformed envelope (core plan 07 §5.4)."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = var.tags

  criteria {
    metric_namespace = "Microsoft.ServiceBus/namespaces"
    metric_name      = "DeadletteredMessages"
    aggregation      = "Average"
    operator         = "GreaterThanOrEqual"
    threshold        = var.dead_letter_alert_threshold

    dimension {
      name     = "EntityName"
      operator = "Include"
      values   = ["effects"]
    }
  }
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
