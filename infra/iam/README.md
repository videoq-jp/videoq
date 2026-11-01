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

Scope policy: `iam`/`PassRole` is limited to the existing worker role. Creation,
deletion and permissions-boundary changes require an operator session; SSM is limited to
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

Routine migration, backup, smoke and credential-maintenance GitHub jobs use
main-only `production-db-*` Environments and distinct invocation roles. Their
`AWS_GITHUB_ACTIONS_DB_REQUEST_ROLE_ARN` secrets identify roles with only
`lambda:InvokeFunction` on the exact published starter alias. No SSM read,
CodeBuild start/override, code upload or maintenance IAM permissions are granted.
The starters validate operations and canonical-main migration sources, acquire
an AWS global lock, and start the fixed state machine. They hold no DB credentials.

AWS CodeBuild service roles hold purpose-specific parameter grants. Only the
rotation role can read the administrator and Hyperdrive credentials or write
consumer parameters. Its operator source is an immutable S3 object version,
deployed with a separate operator session. The independent maintenance state is
outside GitHub's state-write grant. `videoq-tfstate-access` is limited to the main
state object and its lock, rather than every object in the bucket.

The demo preparation and read-only demo audit jobs retain exact single-parameter
SSM readers in `AWS_GITHUB_ACTIONS_NEON_ROLE_ARN`. The planning role remains
main-only and explicitly denies protected SSM values/history and all recursive
reads. Lambda's runtime role reads its worker DB parameter and application settings.

Provision new starters first, then run `python3 infra/scripts/setup_neon_access.py`
with an operator AWS session. It validates the account and published aliases,
configures new invocation roles without changing old readers, and stores their
ARNs in the dedicated Environments. Retire old migration/backup/smoke readers and
the old GitHub rotation role only after successful main workflow cutover.

The reviewer-protected initial Hyperdrive handoff still uses its write-only
bootstrap role and protected SSM parameter. Reinitialize it when the existing
Cloudflare infrastructure token is renewed. DB administrator credentials are
never exposed by that handoff. See [DB security](../DB_SECURITY.md) and the
[AWS rollout procedure](../db-maintenance/README.md).
