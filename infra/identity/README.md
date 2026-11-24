# Identity and retained control metadata

This operator-owned Terraform root uses its own R2 state. It adopts VideoQ OIDC
roles, policies, existing IAM users/access-key metadata, the shared GitHub OIDC
provider, retained control SSM parameter metadata and legacy API logs.

Use the [R2 runbook](../TERRAFORM.md). Production identity/storage has
`prevent_destroy`. Access keys are observed with data sources; their lifecycle belongs to credential
rotation. Terraform never regenerates a retired key or recovers its secret half. SSM placeholder values are ignored after import;
credential rotation owns the actual values. Do not apply placeholders to an
existing parameter through another tool.

An operator credential is required. Application CD must not update its own IAM
trust/permissions. Existing JSON templates in `infra/iam/` are historical
references; update and apply this Terraform root instead of calling IAM CRUD
commands from those old setup instructions.

## Retired outbound inference identity

The former inference provider's AWS outbound issuer is retired with the pinned
AWS provider's `aws_iam_outbound_web_identity_federation` resource. Terraform
Search does not list this resource in provider 6.73.0, so the existing account
issuer was discovered using IAM and imported read-only by account ID. The
`removed` block in `retired-outbound-identity.tf` disables that existing issuer;
it never enables or recreates outbound federation. The live plan must show only
that removal in addition to any separately reviewed identity changes.

The ownership inventory found explicit outbound-token grants only on the former
VideoQ worker/API principals and their runtime boundary, all restricted to the
retired provider's audience. Provider-side trust and inference keys have already
been deleted. Use the R2 wrapper and this root for retirement; retain the state
history after the issuer is disabled.
