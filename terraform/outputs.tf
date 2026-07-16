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

output "key_vault_uri" {
  value = module.key_vault.uri
}
