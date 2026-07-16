terraform {
  # Remote state in an Azure Storage container. Concrete values are supplied per
  # environment via `-backend-config` in CI (see .github/workflows/terraform.yml),
  # so no secrets live in the repo.
  backend "azurerm" {
    container_name = "tfstate"
    # resource_group_name  = "<rg>"          via -backend-config
    # storage_account_name = "<sa>"          via -backend-config
    # key                  = "<env>.tfstate" via -backend-config
    use_oidc = true
  }
}
