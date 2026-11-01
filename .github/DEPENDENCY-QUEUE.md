# GitHub Merge Queue

GitHub's standard Merge Queue manages merge order into main and integration CI.
Ordinary development PRs also use this queue when merging to main.
Dependency Automation automatically queues only verified Dependabot major/minor/patch updates
and managed-bot `runtime/*-current` PRs. People decide on new runtime lines and excluded PRs.
The controller never removes a PR that a person queued, even if it is outside automatic processing.
It removes only entries queued by the update bot itself, when origin verification fails or an exclusion applies.

After normal PR CI succeeds, the controller queues the PR by its current head SHA.
GitHub creates a commit merging latest main with the PR and runs `merge_group` CI.
Integration builds run one at a time and a merge group holds one PR, so merging an earlier PR
does not invalidate later speculative builds. Ordinary main updates do not regenerate or rebase waiting PR branches.

The required checks are GitHub Actions' `CI Success`, `Supply Chain Security`,
`Terraform Plan`, and `Container Validation`, and they apply to administrators.
"Require branches to be up to date" is disabled; Merge Queue is required instead.
See [.github/native-merge-queue.json](native-merge-queue.json) for the settings.
The queue's wait limit is 120 minutes, so it can wait for on-prem validation's 90-minute limit.

## CI failures, conflicts, and Claude repairs

For a failure in the queue, the controller checks the actual workflow ID, repository,
ancestry against the current PR head, and the bot update's origin. Only when needed does it bring
that PR up to main and reproduce the failure in normal PR CI, at most twice per PR.
The synthetic queue commit is never handed to Claude directly.
Once normal PR CI verifies a repairable failure, the existing Claude decision applies.
A conflicting Dependabot PR also goes to Claude after verifying the signed original update and current main.
Claude fixes compatibility across configuration, generated types, and tests, then the PR returns to the same queue through normal CI.
CI repair and conflict resolution each allow up to eight attempts; the same head can retry after a run completes, and duplicate runs are not started while one is active.
Failed security scans, unverified changes, and reaching the repair limit still need human review.

No status Issues, runner-availability jobs, or custom required checks are used.
It runs on PR events, main pushes, and CI and Claude worker completion events, without scheduled polling to follow main.
Runtime daily discovery continues in order to find new official releases.

## Operation

- `DEPENDENCY_AUTOMERGE_ENABLED=true` enables the automatic update controller.
- `RUNTIME_AUTOMERGE_ENABLED=false` stops automatically queueing runtime PRs.
- `CLAUDE_DEPENDENCY_REPAIR_ENABLED=true` permits repairing eligible CI failures.
- See [dependency automation](dependency-automation.md) for exclusions such as `no-automerge`,
  `no-runtime-update`, `no-rebase`, and `no-claude`.

To stop automatic queueing, set `DEPENDENCY_AUTOMERGE_ENABLED=false`.
Keep main's Merge Queue rule and required checks; ordinary development PRs still merge through the queue.
Remove already queued PRs individually in the queue view. Do not disable protection to merge directly.
