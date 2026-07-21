# terraform — Azure IaC

One root config parameterized per environment (`environments/dev.tfvars`,
`prod.tfvars`), remote state in Azure Storage, reusable modules, OIDC-federated CI
(no long-lived cloud secrets).

## Layout

- `main.tf` / `variables.tf` / `outputs.tf` / `versions.tf` / `providers.tf` /
  `backend.tf` — root. Providers pinned (`azurerm ~> 4`, `azuread ~> 3`).
- `modules/` — `container-apps` (web/api/worker in a shared Container Apps
  Environment; worker scales on a Service Bus KEDA rule), `postgres` (Flexible
  Server), `container-registry` (ACR), `key-vault` (secrets + RBAC), `service-bus`
  (namespace + queues/topics/subscriptions), `storage` (account + blob container),
  `identity` (user-assigned MI + least-privilege role assignments),
  `observability` (Log Analytics).
- `.terraform.lock.hcl` is committed; `.terraform/` and `*.tfstate*` are ignored.

## Secrets flow

Sensitive vars (`subscription_id`, `postgres_admin_password`, `resend_api_key`,
`better_auth_secret`) arrive via `TF_VAR_*` env vars in
CI — never `-var` flags, never committed. They're written to Key Vault and
injected into Container Apps as secret refs via the managed identity.

## CI

- `.github/workflows/terraform.yml` — PR: fmt/validate/plan; push to `dev`/`prod`
  or dispatch: apply. Auth via `azure/login` OIDC.
- `.github/workflows/build-and-push.yml` — builds api/web/worker images → ACR,
  then `az containerapp update`.

## Operational notes

- The CI service principal needs **Key Vault Secrets Officer** on the vault (data
  plane) to write secrets, plus Contributor on the subscription/RG.
- Remote state backend config (`resource_group_name`, `storage_account_name`,
  `key`) is passed via `-backend-config` in CI, not committed.
