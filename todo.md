Review CI - terraform plan
(migrations + extension ordering: DONE — `migrate` job in terraform.yml runs
after apply, opens/closes a firewall window for the runner. Adding an
extension to a migration means adding it to `azure.extensions` in the same
change. See terraform/CLAUDE.md "Database migrations".)
sync entra directory with app
