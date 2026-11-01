# Recurring operations automation

`operations.yml` (Operations) is the single entry point for monitoring. For manual runs,
choose a target with `check`; `all` runs everything, including the database restore.
Daily runs cover all monitors except the database restore, plus on-prem validation.
Mondays add inference compatibility, the monthly run performs the database restore, and a
successful CD runs only the production smoke.

## Temporary Actions storage

Ordinary push and PR CI builds and tests, but does not store copies of the app, Storybook,
or documentation. CD generates verified deployable artifacts within its own run and does
not use CI's copies. When you need a copy for investigation, run CI manually: it can still
keep them for seven days. Manual CI selects these builds regardless of the changed files
and does not start an automatic deployment. Passing coverage to jobs that read it remains.

Large on-prem image archives are deleted only after every publish job has published and
signed successfully, and only the eight archives from the same run, commit, and attempt.
Later steps use the published digests. Separation of build and publish permissions,
vulnerability scanning, and retention of signatures and evidence are unchanged. Archives
from failed or cancelled runs use the existing one-day expiry.

VideoQ is a public repository. This storage policy is not a way to resolve a storage
shortage in a separate private repository. Per [GitHub's billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
check public and private repository usage and billing separately. When cleaning up past
artifacts, protect running work, set aside the original ZIP and metadata, and verify the
SHA-256 and ZIP integrity before deleting. Deleting on GitHub is irreversible and does
not cancel usage incurred beforehand.

## Recurring checks

| Target | When (JST; GitHub may delay) | Result |
| --- | --- | --- |
| CodeQL | PRs, main updates, Mondays 11:11 | Security > Code scanning |
| OSV scan of all dependencies | Daily 09:17 | Actions run and summary |
| Vulnerability scan of pinned upstream on-prem images (llama.cpp, whisper.cpp) | Daily 09:17 | Actions run and summary |
| Public page SEO audit (`seo-monitor.yml`) | Daily 08:43 | Report kept for 90 days |
| API AWS key age audit (`api-aws-key-rotation.yml`) | Mondays 11:23 | Fails when an active key reaches 80 days |

Scheduled workflows run only from main. You can also use Run workflow in Actions.
Dependencies are not installed; all reviewed lockfiles are scanned as data.
Scan service errors and incomplete results do not count as passing. A finding fails the
scheduled scan, and findings without a fixed version are reported too.
PR scans of newly introduced versions run alongside the recurring full scan.
A pinned upstream image cannot change unless its digest changes, and new advisory data alone
can fail a scan. CI therefore scans only PRs that change the pins or scan settings, so
unrelated PRs are not blocked. Daily on-prem validation always scans and fails on findings
without a fixed version.

Operations monitoring does not create, update, or reopen Issues. Results and details go to
Actions runs and summaries. Workflows still fail on problems; delivery follows GitHub's Actions
notification settings. Dependabot and runtime update PRs, Claude repairs, and Merge Queue
processing continue. Cloudflare token expiry monitoring also creates no Issues and fails
Actions from seven days before expiry.

| VideoQ-specific monitor | When (JST) | What it does |
| --- | --- | --- |
| Production smoke test | After CD success; daily 09:17 | health/ready, login page, video upload with a dedicated user, processing, transcription, embeddings, and list pages. Manual runs can add paid cited Q&A with `verify_ai_answers=true` |
| Production container scan | Daily 09:17 | Trivy scan of the ECR digest Lambda actually references: HIGH/CRITICAL, including unfixed |
| Terraform drift check | Daily 09:17 | Plan only. Never applies and does not publish attribute values |
| Logical backup restore test | 1st of each month 13:41 | Dumps from one read-only snapshot, restores to isolated PostgreSQL, and verifies all application table counts and constraints |

Jobs that access the production database use the main-only `production-app` environment.
Before any privileged step, tools from the separate `.github/operations-tools` lockfile are
installed with lifecycle scripts disabled, and their signatures are verified.
Dependabot creates PRs for operations tools and the restore image. Changes outside the
automation policy are reviewed by a person.

The smoke user has a random ID, an invalid email domain, ordinary permissions, and limits of
one processing minute and 0.01 GB of storage. It sends no email. After deleting the test
video through the normal API, only the dedicated user matching several identifiers is deleted.
A video still processing is not deleted; the run reports it and rechecks next time. If the
previous video is still processing, no new upload is created.
Database credentials, cookies, signed URLs, user data, and screenshots are not written to logs
or artifacts. Daily runs incur normal usage charges for processing a short video and AI embeddings.

The restore test's dump stays in a temporary runner file and is removed with the isolated
container. This checks that the logical backup can be restored. It does not cover long-term
retention, Neon PITR, or restoring R2 video files. A PostgreSQL major version change is an
error until the restore client has been reviewed.

Terraform and ECR monitoring use the existing read-only AWS plan role. Its trust condition adds
only this repository's main ref to the existing pull_request access. Replace the AWS account ID
in `infra/iam/videoq-github-actions-plan-trust.json` and apply it.
Terraform state, plan files, and attribute values are not published. Standard backend locking
coordinates with a running apply. The Actions concurrency groups are separate so an apply awaiting
approval does not block the daily check. Monitoring changes no infrastructure and only takes and
releases the temporary lock required for state file exclusion.
When updating providers, record CI's unpacked hashes with `terraform providers lock -platform=linux_amd64`.
PR Terraform validation also treats the lockfile as read-only so implicit updates in CI cannot hide problems.
The `production-infra` approval for ordinary infrastructure changes and the conditions for
automatically applying verified Dependabot minor/patch updates are unchanged.

Terraform Apply checks for differences with the read-only plan role before requesting approval.
With no differences, it skips the approval and apply jobs, succeeds, and creates no
production-infra deployment record. Only with differences does it continue to the existing
approval or automatic dependency apply. A plan failure stops the apply, and values and state
files are not published to logs or artifacts.

Runtime Updates prepares update PRs for Node.js, Python, npm, pip, and uv daily at 09:13 JST.
See [RUNTIME-UPDATES.md](RUNTIME-UPDATES.md) for distribution hash checks, per-line PRs, and
validation in the runtime environment.

Production runbooks are in [`docs/operations/`](../docs/operations/).
