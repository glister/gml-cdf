# Managed certificates and hostname bindings for one environment's custom
# domains. **DNS is not managed here.**
#
# `cdfencing.co.uk` is hosted at Krystal (`dig NS cdfencing.co.uk`), whose
# hosting package does not permit delegating a child zone to Azure, so the
# records are created by hand in the Krystal panel. Terraform owns everything
# downstream of them: certificate issuance, renewal and the binding.
#
# Every hostname is an ordinary subdomain of the Krystal-hosted zone — there is
# no zone apex in play — so all four are plain CNAMEs and all four certificates
# validate by CNAME. That is the cheapest and most reliable path Azure offers.
#
# Ordering. A certificate cannot be issued until its CNAME resolves, so this
# module stays inert until `enabled` is set. The sequence is:
#
#   1. Apply with enabled = false. Read `terraform output dns_records_required`.
#   2. Create those records at Krystal. Confirm with `dig`.
#   3. Apply with enabled = true — certificates issued, hostnames bound.
#
# Enabling before the records resolve fails certificate validation. That is a
# sequencing error, not a config error: create the records, then re-apply.

variable "container_app_environment_id" { type = string }

variable "dns_parent_zone" {
  description = "The Krystal-hosted zone the records live in, e.g. cdfencing.co.uk."
  type        = string
}

variable "bindings" {
  description = <<-DESC
    Hostnames to serve, keyed by app. Each must be a subdomain (not an apex) so
    that a CNAME is legal and CNAME certificate validation applies.
  DESC
  type = map(object({
    container_app_id = string
    hostname         = string
  }))
}

variable "tags" {
  type    = map(string)
  default = {}
}

# Azure issues the certificate against the hostname's CNAME, so a hostname that
# is really the zone apex would fail at apply time with an opaque validation
# error. Catch it at plan time instead.
#
# Compared against the zone rather than counted in labels: `.co.uk` is a
# two-label public suffix, so `cdfencing.co.uk` is an apex with three labels and
# any dot-counting heuristic waves it through.
resource "terraform_data" "subdomain_guard" {
  for_each = var.bindings

  lifecycle {
    precondition {
      condition     = each.value.hostname != var.dns_parent_zone && endswith(each.value.hostname, ".${var.dns_parent_zone}")
      error_message = "binding \"${each.key}\": ${each.value.hostname} must be a subdomain of ${var.dns_parent_zone}. An apex hostname needs an A record to the environment IP plus HTTP validation, which this module deliberately does not implement."
    }
  }
}

resource "azurerm_container_app_environment_managed_certificate" "this" {
  for_each = var.bindings

  name                         = replace(each.value.hostname, ".", "-")
  container_app_environment_id = var.container_app_environment_id
  subject_name                 = each.value.hostname
  domain_control_validation    = "CNAME"
  tags                         = var.tags
}

resource "azurerm_container_app_custom_domain" "this" {
  for_each = var.bindings

  name                                     = each.value.hostname
  container_app_id                         = each.value.container_app_id
  container_app_environment_certificate_id = azurerm_container_app_environment_managed_certificate.this[each.key].id
  certificate_binding_type                 = "SniEnabled"
}

output "bound_hostnames" {
  value = [for k, b in var.bindings : b.hostname]
}
