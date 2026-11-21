# Production API AWS key rotation

The API remains on Cloudflare Workers. Its IAM user must have only
`sqs:SendMessage` on `videoq-worker-prod` and the existing audience/RS256/900-second
restricted `sts:GetWebIdentityToken` statement. No API hosting migration or mTLS
integration is part of this procedure.

## One-time administrator setup

The current deployment role cannot inspect/manage this IAM user's keys. An AWS
administrator must perform these two scoped changes using the normal IAM console:

1. On IAM user `videoq-workers-api`, replace only inline policy
   `videoq-sqs-send` with [the send-only policy](../../infra/iam/videoq-api-sqs-send.json).
   Keep `videoq-openrouter-federation` unchanged. The runtime sends messages to an
   explicit queue URL; it does not use `GetQueueUrl` or `GetQueueAttributes`.
2. On the deployment role referenced by `AWS_GITHUB_ACTIONS_DEPLOY_ROLE_ARN`
   (normally `videoq-github-actions-deploy`), add
   [the key-rotation operator policy](../../infra/iam/videoq-api-key-rotation-operator.json).
   It permits inspection and key lifecycle actions for this single IAM user;
   it grants no user-policy edits, role changes, or access to other users' keys.
   The role already has SSM access to `/videoq/prod/*`.

The script refuses broader/inherited/managed user policies and a different
principal. These checks run before creating a replacement key. Never send any
access key or secret key through chat, workflow inputs, logs, or artifacts.

## Staged procedure

Each write stage is main-only and uses the existing `production-infra` gate.
Run stages against reviewed current main while no API deployment is in flight.

1. Dispatch `api-aws-key-rotation.yml` with `operation=install`. It verifies the
   exact user permissions and production federation settings, creates a second
   key, persists it in SecureString `/videoq/prod/api-key-rotation`, verifies its
   AWS identity, and patches the two Worker secrets in one Cloudflare operation.
   The old key remains active. A temporary credential journal makes interrupted
   installs retryable without creating additional keys. A persistence failure
   before the journal is confirmed leaves the Worker and original key unchanged;
   audit any ambiguous second-key state before retrying.
2. Dispatch `operations.yml` with `check=smoke` and `verify_ai_answers=true`.
   Require successful upload, transcription, indexing, cited Q&A and cleanup.
3. Dispatch `api-aws-key-rotation.yml` with `operation=disable-old` and
   `verification_run_id` from step 2. The script checks the canonical workflow,
   successful result, a start time after installation, and the actual smoke log
   markers before deactivating the original key. It does not delete it yet.
4. Run another complete cited-Q&A smoke after deactivation.
5. Dispatch `operation=finalize` with this second run ID. A different, later proof
   is mandatory. The script confirms the old key is inactive, deletes it, checks
   that only the new active key remains, and deletes the temporary SSM parameter
   including its credential-bearing history.

If a stage fails, inspect the redacted reason. Do not skip proof requirements or
remove the old key manually to make a check pass. Installation failures retain
the original key; after deactivation the old key remains recoverable until the
second smoke confirms the replacement. The script never changes IAM policies.

## Recurring check

The same workflow's weekly read-only `audit` job uses the existing plan role,
without deployment tokens or a production approval gate. It reports ages and
fails when an active key reaches 80 days, leaving time to rotate before 90 days.
Run the staged procedure again when due. No automatic key deletion occurs on a
schedule.

Sources: [Cloudflare bulk secret patch](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/),
[AWS IAM access-key management](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html).
