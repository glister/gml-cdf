# DNS zone, records, managed certificates and hostname bindings for one
# environment's custom domains.
#
# Delegation model (runbook §11): `cdfencing.co.uk` stays at Krystal. Only the
# per-environment subdomain is delegated into Azure — `connect.cdfencing.co.uk`
# into the prod subscription, `dev.connect.cdfencing.co.uk` into non-prod — so
# each subscription owns its own zone outright and neither CI identity needs
# rights in the other's subscription. Corporate MX/M365 records are untouched.
#
# Two-phase by design. The zone's name servers only exist once Terraform has
# created the zone, but the delegation at Krystal has to point at them before
# Azure can validate anything. So `enable_bindings` gates the half that needs
# public DNS to resolve:
#
#   1. enable_bindings = false — zone + records created. Take the
#      `name_servers` output to Krystal and delegate.
#   2. enable_bindings = true  — certificates issued and hostnames bound.
#
# Running phase 2 before the delegation propagates fails the certificate with a
# domain-validation error. That is a sequencing error, not a config error:
# delegate, confirm with `dig NS <zone>`, then re-apply.

variable "dns_zone_name" {
  description = "Delegated zone for this environment, e.g. connect.cdfencing.co.uk."
  type        = string
}

variable "resource_group_name" { type = string }

variable "container_app_environment_id" { type = string }

variable "container_app_environment_static_ip" {
  description = "Environment inbound IP; the apex A record target."
  type        = string
}

variable "bindings" {
  description = <<-DESC
    Hostnames to serve, keyed by app. `hostname` must be the zone apex or a name
    beneath it. `ingress_fqdn` is the app's generated *.azurecontainerapps.io
    name (the CNAME target for non-apex hostnames).
  DESC
  type = map(object({
    container_app_id = string
    hostname         = string
    ingress_fqdn     = string
    verification_id  = string
  }))
}

variable "enable_bindings" {
  description = "Phase 2 switch — issue certificates and bind hostnames. Requires the zone to be delegated and resolving."
  type        = bool
  default     = false
}

variable "record_ttl" {
  type    = number
  default = 300
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  # Relative record name within the zone: "@" for the apex, otherwise the
  # prefix. `api.connect.cdfencing.co.uk` in zone `connect.cdfencing.co.uk`
  # becomes "api".
  relative = {
    for k, b in var.bindings : k => (
      b.hostname == var.dns_zone_name
      ? "@"
      : trimsuffix(b.hostname, ".${var.dns_zone_name}")
    )
  }

  apex_bindings = { for k, b in var.bindings : k => b if local.relative[k] == "@" }
  sub_bindings  = { for k, b in var.bindings : k => b if local.relative[k] != "@" }

  # Certificates and bindings only once the zone is actually delegated.
  active_bindings = var.enable_bindings ? var.bindings : {}
}

# Every hostname must sit inside the zone, or the records below would silently
# land in the wrong place.
resource "terraform_data" "hostname_guard" {
  for_each = var.bindings

  lifecycle {
    precondition {
      condition     = each.value.hostname == var.dns_zone_name || endswith(each.value.hostname, ".${var.dns_zone_name}")
      error_message = "binding \"${each.key}\": hostname ${each.value.hostname} is not the zone ${var.dns_zone_name} nor beneath it."
    }
  }
}

resource "azurerm_dns_zone" "this" {
  name                = var.dns_zone_name
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

# --- Records ---------------------------------------------------------------

# Apex: A record to the environment's inbound IP. A CNAME is illegal at a zone
# apex, and Azure DNS alias records cannot target a Container App.
resource "azurerm_dns_a_record" "apex" {
  for_each = local.apex_bindings

  name                = "@"
  zone_name           = azurerm_dns_zone.this.name
  resource_group_name = var.resource_group_name
  ttl                 = var.record_ttl
  records             = [var.container_app_environment_static_ip]
  tags                = var.tags
}

resource "azurerm_dns_cname_record" "sub" {
  for_each = local.sub_bindings

  name                = local.relative[each.key]
  zone_name           = azurerm_dns_zone.this.name
  resource_group_name = var.resource_group_name
  ttl                 = var.record_ttl
  record              = each.value.ingress_fqdn
  tags                = var.tags
}

# Ownership proof. Azure looks for `asuid` at the apex, `asuid.<prefix>`
# otherwise.
resource "azurerm_dns_txt_record" "asuid" {
  for_each = var.bindings

  name                = local.relative[each.key] == "@" ? "asuid" : "asuid.${local.relative[each.key]}"
  zone_name           = azurerm_dns_zone.this.name
  resource_group_name = var.resource_group_name
  ttl                 = var.record_ttl
  tags                = var.tags

  record {
    value = each.value.verification_id
  }
}

# --- Certificates and bindings (phase 2) -----------------------------------

# Validation method follows the record shape: a non-apex hostname already
# CNAMEs to its app, so CNAME validation is the cheapest proof. The apex has an
# A record instead, so it falls back to the TXT above.
resource "azurerm_container_app_environment_managed_certificate" "this" {
  for_each = local.active_bindings

  name                         = replace(each.value.hostname, ".", "-")
  container_app_environment_id = var.container_app_environment_id
  subject_name                 = each.value.hostname
  domain_control_validation    = local.relative[each.key] == "@" ? "TXT" : "CNAME"
  tags                         = var.tags

  depends_on = [
    azurerm_dns_a_record.apex,
    azurerm_dns_cname_record.sub,
    azurerm_dns_txt_record.asuid,
  ]
}

resource "azurerm_container_app_custom_domain" "this" {
  for_each = local.active_bindings

  name                                     = each.value.hostname
  container_app_id                         = each.value.container_app_id
  container_app_environment_certificate_id = azurerm_container_app_environment_managed_certificate.this[each.key].id
  certificate_binding_type                 = "SniEnabled"
}

# --- Outputs ---------------------------------------------------------------

# Phase 1's deliverable: the delegation records to create at Krystal.
output "name_servers" {
  description = "NS records to set for this zone at the parent registrar."
  value       = azurerm_dns_zone.this.name_servers
}

output "zone_name" {
  value = azurerm_dns_zone.this.name
}

output "bound_hostnames" {
  value = [for k, b in local.active_bindings : b.hostname]
}
