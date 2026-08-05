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
