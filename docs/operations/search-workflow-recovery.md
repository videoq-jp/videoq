# Inspect and restart terminal search Workflows

Queue redelivery creates or finds the deterministic Workflow ID and acknowledges only a durable handoff. An existing `errored` or `terminated` instance is retried, never silently restarted. Requeueing is therefore different from this explicit administrator restart, which clears durable step state ([Cloudflare restart documentation](https://developers.cloudflare.com/workflows/build/trigger-workflows/#restart-a-workflow)).

Use the authenticated admin API on the exact deployment that owns DB, VIDEO_BUCKET and SEARCH_INDEX_WORKFLOW. The CLI uses a native administrator session cookie; API keys and a merely present Authorization header do not grant administrator access. It rejects redirects and requires HTTPS; `--local` permits HTTP only on loopback. Do not put credentials in command arguments, job files, reports or shell history. Supply `VIDEOQ_ADMIN_SESSION_COOKIE` through the operator's secret environment.

```sh
cd apps/api
npx tsx scripts/search-workflow-recovery.ts --api https://isolated-api.example --job-file /secure/job.json --inspect
npx tsx scripts/search-workflow-recovery.ts --api https://isolated-api.example --job-file /secure/job.json --restart --expected-inspection <reviewed-inspection-sha256>
```

The job file is the exact original wire message, including job_id/type/payload. Inspect corresponds to `admin.inspectSearchRecovery` query `{job}`; restart corresponds to `admin.restartSearchWorkflow` mutation `{job,inspection}`. Both use existing session authentication and adminProcedure. No remote Workflow proxy is used: all bindings are accessed by the deployed API itself.

Inspection rejects nonterminal instances, completed jobs, conflicting job identity, active execution leases, removed sources and saved source snapshots that no longer match owner/video/revision/file/transcript. Its content-free digest binds the API origin, deterministic Workflow ID, terminal status, job payload hash, ledger facts, current source hash and every R2 artifact's key/content hashes. Changing any reviewed fact requires a new inspection. Raw source, object keys, lease tokens and exception strings are absent from output and audit.

Restart claims a normal execution lease, rechecks source/artifact/status evidence under that lease, verifies ownership and heartbeat, writes an R2 audit intent, calls `instance.restart()`, and writes acceptance. The fenced reservation is released in finally. A restarted Workflow retries a busy claim until release; if the administrator process dies the normal 900-second lease expires. Lease release failure has its own safe event and audit sidecar and cannot mask restart acceptance or the primary error. Do not manually clear a live lease or delete job rows to bypass these safeguards.

R2 work artifacts remain intact during the control operation. Restart begins with fresh durable steps and a new run ID; source and publication fences remain active throughout processing. Successful completion cleans the work-artifact prefix and keeps `internal/search-recovery/<auditId>.json`. A saved snapshot for an older source is rejected; use a newly authorized indexing job for the current source instead of overwriting it through old-job recovery.

After acceptance, inspect Workflow status through the platform and reconcile job_executions identity/status/attempts, video_index_heads and scene_index_runs, queued vector tasks and Vectorize state, work-artifact cleanup and recovery audit. Acceptance means the platform accepted restart, not that indexing completed. An intent with no acceptance is ambiguous: inspect the actual Workflow and ledger before further action. Preserve existing queue retry/DLQ policy. A failed visibility change does not delete or acknowledge the SQS message; the original visibility deadline remains relevant ([AWS API semantics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html)).

## Verification scope

`test/persistence/search-workflow-recovery.integration.test.ts` runs the actual SearchIndexWorkflow body on local workerd with real Workflow/D1/R2 bindings and the actual migration chain. A fixture supplies deterministic embeddings and injects terminal failure after staging; a second case explicitly terminates an instance. Both use the actual recovery implementation, verify reviewed-digest rejection, restart through the platform binding, completed ledger, exactly one published head, work-artifact cleanup and retained content-free audit. This is isolated local platform evidence, not a production exercise or a live provider quality claim. Guard tests cover active/completed/conflicting jobs, nonterminal Workflow status, source edits, changed artifacts and origin mismatch. Deployed isolated verification is recorded separately when performed; never substitute mocked restart for that evidence.
