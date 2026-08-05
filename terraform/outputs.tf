output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "acr_login_server" {
  value = module.acr.login_server
}

output "api_fqdn" {
  value = module.container_apps.api_fqdn
}

output "web_fqdn" {
  value = module.container_apps.web_fqdn
}

output "postgres_fqdn" {
  value = module.postgres.fqdn
}

# Consumed by the `migrate` job in .github/workflows/terraform.yml: the server
# name to attach a temporary firewall rule to, and the database to migrate.
output "postgres_server_name" {
  value = module.postgres.server_name
}

output "postgres_database_name" {
  value = module.postgres.database_name
}

output "postgres_admin_login" {
  value = var.postgres_admin_login
}

output "key_vault_uri" {
  value = module.key_vault.uri
}

# The records to create by hand in the Krystal panel before flipping
# `enable_custom_domains` to true. Available from the first apply onward — it is
# derived from the apps, not from the custom-domains module, so it does not
# depend on the flag it exists to unblock. See runbook §11.
#
# `host` is the name relative to the `cdfencing.co.uk` zone, which is how
# Krystal's panel asks for it; entering the FQDN instead usually results in a
# doubled suffix.
output "dns_records_required" {
  description = "CNAME + asuid TXT records to create at Krystal for the custom domains."
  value = [
    for r in [
      {
        app             = "web"
        hostname        = local.web_hostname
        cname_target    = module.container_apps.web_fqdn
        verification_id = module.container_apps.web_custom_domain_verification_id
      },
      {
        app             = "api"
        hostname        = local.api_hostname
        cname_target    = module.container_apps.api_fqdn
        verification_id = module.container_apps.api_custom_domain_verification_id
      },
      ] : {
      app   = r.app
      cname = { host = trimsuffix(r.hostname, ".${var.dns_parent_zone}"), value = r.cname_target }
      txt   = { host = "asuid.${trimsuffix(r.hostname, ".${var.dns_parent_zone}")}", value = r.verification_id }
    }
  ]
}

output "bound_hostnames" {
  value = try(module.custom_domains[0].bound_hostnames, [])
}
