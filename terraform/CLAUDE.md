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
  or dispatch: apply, **then `migrate`**. Auth via `azure/login` OIDC.
- `.github/workflows/build-and-push.yml` — builds api/web/worker images → ACR,
  then `az containerapp update`.

## Bootstrap

Everything above assumes the Azure landing zone already exists. The one-time
manual setup — subscriptions, resource providers, the remote-state storage
account, Entra app registrations + OIDC federated credentials, role assignments
and GitHub Environment secrets — is
[`docs/runbooks/azure-bootstrap.md`](../docs/runbooks/azure-bootstrap.md).

## Database migrations

The `migrate` job in `terraform.yml` runs `pnpm --filter @repo/db migrate:ci`
against the environment `deploy` just applied. Three things about it are
load-bearing:

- **It runs after `terraform apply`, not before.** A migration can depend on
  infrastructure the apply creates: core plan 05's team migration calls
  `CREATE EXTENSION btree_gist`, which Azure refuses until the `azure.extensions`
  server parameter allow-lists it (`modules/postgres/main.tf`). Reversed, the
  failure surfaces confusingly inside a SQL file. **Adding an extension to a
  migration means adding it to `azure.extensions` in the same change** — and that
  parameter is a single comma-separated string, so append, never replace.
- **The runner buys network access for the job and hands it back.** The server is
  public with only the `0.0.0.0` "allow Azure services" rule, which a
  GitHub-hosted runner is not reliably covered by. The job opens a firewall rule
  named `ci-migrate-<run-id>` for its own egress IP and removes it in an
  `if: always()` step. A rule surviving a hard-killed runner is findable by that
  prefix. **If Postgres ever moves behind a VNet this stops working**, and
  migrations must run from inside Azure (a Container Apps job) or a self-hosted
  runner.
- **`POSTGRES_SSL=true` is required against Azure.** Flexible Server sets
  `require_secure_transport = ON`, so an unencrypted connection is refused
  outright. Local and CI-container Postgres speak plaintext, hence the `false`
  default in `.env`/`.env.test`.

`migrate:ci` exists separately from `migrate` because the latter is
`tsx --env-file ../../.env`, and `.env` is the committed **dev** config. Node's
`--env-file` does not overwrite variables already in the environment, so the
plain script would in fact work in CI — but by a subtlety, and one edit away from
silently pointing production migrations at a dev host.

## Operational notes

- The CI service principal needs **Key Vault Secrets Officer** on the vault (data
  plane) to write secrets, Contributor on the subscription/RG, and **Role Based
  Access Control Administrator** — Contributor cannot create the role assignments
  in `modules/identity`.
- Remote state backend config (`resource_group_name`, `storage_account_name`,
  `key`) is passed via `-backend-config` in CI, not committed.
