# Identity and retained control metadata

This operator-owned Terraform root uses its own R2 state. It adopts VideoQ OIDC
roles, policies, existing IAM users/access-key metadata, the shared GitHub OIDC
provider, retained control SSM parameter metadata and legacy API logs.

Use the [R2 runbook](../TERRAFORM.md). Production identity/storage has
`prevent_destroy`. Imported access-key IDs are retained; Terraform never
recovers their secret halves. SSM placeholder values are ignored after import;
credential rotation owns the actual values. Do not apply placeholders to an
existing parameter through another tool.

An operator credential is required. Application CD must not update its own IAM
trust/permissions. Existing JSON templates in `infra/iam/` are historical
references; update and apply this Terraform root instead of calling IAM CRUD
commands from those old setup instructions.
