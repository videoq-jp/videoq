# GitHub Actions OIDC roles

GitHub Actions obtains temporary AWS credentials through GitHub OIDC without storing
static access keys. Planning and deployment use separate IAM roles so pull requests
cannot change production.

- `videoq-github-actions-plan`: Can be assumed only from main. Grants AWS-managed
  `ReadOnlyAccess` plus state read access and lock operations only.
- `videoq-github-actions-deploy`: Can be assumed only from main or the `production-infra`
  environment. Used for production applies and Lambda deployments.

Permissions are split across four customer-managed policies assigned to the roles.
Replace `<ACCOUNT_ID>` with the actual account ID before applying them; the placeholder
keeps the real ID out of the public repository.

The destination repository uses immutable GitHub OIDC subjects. Its prefix is
`repo:videoq-jp@349188820/videoq@1083911938`; the organization and repository IDs
are public identifiers, not AWS credentials. Confirm the current prefix with
`gh api repos/videoq-jp/videoq/actions/oidc/customization/sub` before changing trust.
Keep the audience restricted to `sts.amazonaws.com` and use only the exact PR,
main and production environment subjects in the templates. Do not switch the
repository back to name-only subjects to work around a trust mismatch.

| Policy | Purpose | Workflow |
|---|---|---|
| `videoq-tfstate-plan` | Read Terraform state and update only the lock object | terraform-plan |
| `ReadOnlyAccess` (AWS managed) | Read AWS resources needed to refresh the plan | terraform-plan |
| `videoq-tfstate-access` | Terraform state (S3 bucket) + `sts:GetCallerIdentity` | terraform-apply |
| `videoq-backend-cd` | Push images to ECR and update Lambda code | cd.yml |
| `videoq-terraform-deploy` | Infrastructure CRUD operations | terraform-apply |

Scope policy: `iam`/`PassRole` is limited to `videoq-*` roles; SSM is limited to
`parameter/videoq/prod/*`; SQS/Lambda/ECR permissions are limited to the relevant
resources. `videoq-terraform-deploy` also includes narrowly scoped permissions to
delete legacy Secrets Manager resources.

## Initial setup

If a GitHub OIDC provider does not yet exist in AWS IAM, create one with
`https://token.actions.githubusercontent.com` as the provider URL and
`sts.amazonaws.com` as the audience. Then run the following once:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
PLAN_ROLE=videoq-github-actions-plan
DEPLOY_ROLE=videoq-github-actions-deploy

sed "s/<ACCOUNT_ID>/${ACCOUNT_ID}/g" \
  infra/iam/videoq-github-actions-plan-trust.json > /tmp/videoq-github-actions-plan-trust.json
aws iam create-role --role-name "$PLAN_ROLE" \
  --assume-role-policy-document file:///tmp/videoq-github-actions-plan-trust.json

sed "s/<ACCOUNT_ID>/${ACCOUNT_ID}/g" \
  infra/iam/videoq-github-actions-trust.json > /tmp/videoq-github-actions-trust.json
aws iam create-role --role-name "$DEPLOY_ROLE" \
  --assume-role-policy-document file:///tmp/videoq-github-actions-trust.json

for p in videoq-tfstate-plan videoq-tfstate-access videoq-backend-cd videoq-terraform-deploy; do
  sed "s/<ACCOUNT_ID>/${ACCOUNT_ID}/g" "infra/iam/${p}.json" > "/tmp/${p}.json"
  aws iam create-policy --policy-name "$p" --policy-document "file:///tmp/${p}.json"
done

aws iam attach-role-policy --role-name "$PLAN_ROLE" \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/videoq-tfstate-plan"
aws iam attach-role-policy --role-name "$PLAN_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess

for p in videoq-tfstate-access videoq-backend-cd videoq-terraform-deploy; do
  aws iam attach-role-policy --role-name "$DEPLOY_ROLE" \
    --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${p}"
done
```

Set the following GitHub repository secrets:

- `AWS_GITHUB_ACTIONS_PLAN_ROLE_ARN`:
  `arn:aws:iam::<ACCOUNT_ID>:role/videoq-github-actions-plan`
- `AWS_GITHUB_ACTIONS_DEPLOY_ROLE_ARN`:
  `arn:aws:iam::<ACCOUNT_ID>:role/videoq-github-actions-deploy`

After verifying the workflows, delete the legacy `AWS_GITHUB_ACTIONS_ROLE_ARN`,
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets and the IAM user's access key.

## Updating policies

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
p=videoq-terraform-deploy   # Name of the policy you changed
sed "s/<ACCOUNT_ID>/${ACCOUNT_ID}/g" "infra/iam/${p}.json" > "/tmp/${p}.json"
aws iam create-policy-version \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${p}" \
  --policy-document "file:///tmp/${p}.json" --set-as-default
# Once there are 5 versions, remove an old version with delete-policy-version
```

> The region is hardcoded as `ap-northeast-1`. To use another region, update the
> ARNs in each JSON file.

## Neon database access

Database jobs use separate `production-db-*` Environments and OIDC roles, with an
exact single-parameter `ssm:GetParameter` grant for each purpose. Their immutable
subject includes the canonical repository IDs and the dedicated Environment name.
`production-app` is not trusted by these roles. Provision the environments/roles
with `python3 infra/scripts/setup_neon_access.py`; it does not retrieve DB values.
The script fails outside the expected AWS account and rejects extra branch policies.

`videoq-github-actions-neon-rotation` is a separate maintenance role trusted only
from main-only `production-db-maintenance`. It can read the administrator credential, read/write the
seven fixed consumer parameters and encrypted rotation journal, and refresh only
`videoq-worker-prod`. It cannot modify IAM policies or retrieve arbitrary secrets.
Its two-hour session covers the Lambda invocation grace period and verification.
The reviewer-protected `Initialize Neon Maintenance` workflow hands off the existing
`CLOUDFLARE_INFRA_TOKEN` to a protected SSM parameter using a separate write-only
bootstrap role. The maintenance role reads that parameter for Hyperdrive updates.

The parameters use the default AWS-managed `aws/ssm` key. Customer-managed keys
require an explicit, exact-key decrypt grant restricted by `kms:ViaService` and the
parameter encryption context; do not replace it with unrestricted KMS permissions.

After all scoped jobs succeed, retire the legacy `videoq-github-actions-neon` role
and its `production-app.AWS_GITHUB_ACTIONS_NEON_ROLE_ARN` secret. Migration credentials
must not be used for audits, backups or smoke checks. See [DB security](../DB_SECURITY.md)
for the complete privilege boundaries, rollout, rotation and recovery procedure.

The plan role also has `deny-protected-neon-credentials`, sourced from
`videoq-neon-plan-deny.json`. This overrides the managed ReadOnlyAccess policy for
protected database parameters and blocks recursive GetParametersByPath reads,
including ancestor paths. PRs run Terraform format/validate/mock tests without AWS
credentials or production state; the existing main apply workflow owns live plans.
