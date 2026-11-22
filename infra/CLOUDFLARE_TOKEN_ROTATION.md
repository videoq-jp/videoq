# Cloudflare token rotation and expiry notifications

[`.github/cloudflare-token-expiry.json`](../.github/cloudflare-token-expiry.json)
is the source of truth for expiry dates. It stores token names, expiry dates,
secret locations, and notification owners, without storing token values.
The deployment and resource-sync tokens issued on 2026-09-18 both expire on
**2026-12-17**. Rotate them no later than the preceding day to switch before expiry.

## Automated notifications

The [`Operations`](../.github/workflows/operations.yml)
workflow checks expiry dates daily at 09:17 JST. It also runs when monitoring
configuration changes on main and can be run manually.

- From 30 days before expiry: Record token names, secret destinations, remaining days, and the applicable expiry stage in the Actions job summary.
- From 7 days before expiry until rotation: Fail the monitoring workflow so it appears in Actions failure notifications.
- The monitor does not create, update, reopen, or comment on Issues.

Use `check=tokens` to run only this monitor; `dry_run` and `preview_date` are available on Operations.

The monitoring job has only `contents: read` permission. It does not use Cloudflare,
AWS, or database secrets, production environments, or external email-service keys.
It does not query the actual Cloudflare tokens, so updating the recorded expiry
date is a required part of rotation.

Enable the following in [GitHub notification settings](https://github.com/settings/notifications).
Both were confirmed enabled on 2026-09-18.

- Participating, @mentions and custom: On GitHub + Email
- Actions: On GitHub + Email + Failed workflows only

This workflow cannot verify whether email was sent or delivered. See
[Actions notification settings](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)
and [notification recipients for scheduled runs](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).

Scheduled workflows in public repositories are
[automatically disabled after 60 days of inactivity](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
and can run later than their scheduled time. Add backup calendar reminders before
expiry and update their dates when rotating tokens. This workflow does not update
the calendar automatically.

## Rotation procedure

1. Issue new Cloudflare tokens. See [DEPLOY.md](DEPLOY.md) for the required permissions.
2. Update the GitHub Environment secrets.
   - Deployment: `production-app.CLOUDFLARE_API_TOKEN` and `production-infra.CLOUDFLARE_API_TOKEN`
   - Resource sync: `production-infra.CLOUDFLARE_INFRA_TOKEN`
3. Confirm that CD and resource sync succeed with the new tokens.
4. Verify where the old tokens are used, then revoke them.
5. Update the relevant `name` and `expiresOn` entries in `.github/cloudflare-token-expiry.json`
   to match the actual new tokens, and merge the change into main through a PR.
   Do not merely postpone the recorded expiry date.
6. Update the backup calendar reminders to the new expiry dates.
7. Confirm that `Operations / tokens` passes and the summary shows the updated dates.

### Background maintenance token in AWS SSM

The dedicated `videoq-background-maintenance-20261123` token expires on
**2027-02-21**. Its destination is the SecureString parameter
`/videoq/security/prod/background-maintenance`, rather than a GitHub secret.
Keep its account scope and required permissions as documented in the
[background migration procedure](../docs/operations/workers-ai-embedding-migration.md).

Rotate it between maintenance executions, after confirming that no execution is
holding paused consumers or awaiting recovery. Preserve the JSON fields
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, write the replacement as a new
SecureString version, and verify the read-back without printing either value.
Verify queue and Workflow metadata access, then complete an isolated pause and
restore check through the maintenance execution role before revoking the old
token. If that check fails, retain the old token for recovery. Do not copy this
credential into GitHub or grant its SSM read permission to ordinary CD.
Update the matching expiry entry and backup reminders after successful rotation.

## Test without sending notifications

Under Actions → Operations → Run workflow, select `check=tokens`, enable `dry_run` and set
`preview_date` to `2026-11-17` (30 days before expiry) or `2026-12-10` (7 days before
expiry). A custom date is allowed only in dry-run mode. The workflow writes the
result to the job summary without creating issues or comments. Normal monitoring
fails on missing or invalid expiry configuration.
