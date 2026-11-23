# IAM ownership

VideoQ OIDC roles, their policy attachments, managed policies and retained IAM
credential metadata are now managed by [infra/identity](../identity/README.md).
The runtime media role remains in `infra/`; its permission boundary belongs to
the archive/maintenance root. All active state is in Cloudflare R2.

The JSON files in this directory are historical policy references and fixture
inputs. They are not a provisioning interface. Do not use an older setup script
to recreate roles or restore obsolete S3-backend write permissions. Use the
Terraform identity root with an operator credential and an exact reviewed plan.

GitHub authentication uses immutable repository OIDC subjects and audience
`sts.amazonaws.com`. Preserve those constraints when changing trust. Application
and planning roles remain separate. Credential bootstrap/rotation occurs in the
credential stores; never commit keys or broaden application CD into an identity
administrator.
