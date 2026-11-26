# Business decision register — 2026-11-25

Authoritative decision: [delegated initial policy in #1684](https://github.com/videoq-jp/videoq/issues/1684#issuecomment-7150223723).
The requester delegated undecided policy choices; the coordinator recorded the decisions.
Decision and review owner for every row: **yukiharada1228**, authenticated repository administrator as verified by the coordinator.
Decided **2026-11-25 JST**; first review due **2026-12-02 JST**. These are initial operational targets, not measured achievements or contractual guarantees.

| ID / current Hot Spot | Decision and status | Normal / failure / cancel / overdue acceptance cases | Implementation and evidence |
|---|---|---|---|
| HS1 Does completed mean searchable? | Decided: current source searchable <=15m after transcript accepted/finalized. Upload confirmation to transcript acceptance measured separately. ACK/workflow creation is not readiness. | Normal: matching source becomes visible in target. Failure: failed index stays pending/error, not completed. Cancel: removed source never becomes ready. Overdue: >15m produces warning; exactly 15m does not. | `scene-index-execution.ts`, `scene-retrieval.ts`; evaluator readiness tests. D1 receipt-gated timestamp collection and maintenance webhook path implemented; production sink configuration and delivery acceptance remain unverified. |
| HS2 When is usage returned? | Decided: unconfirmed upload refunds once into its original reservation period; confirmed monthly upload usage retained. Storage released only after physical cleanup. AI/processing allowance unchanged. | Normal: unconfirmed reservation cancelled once. Failure: cleanup failure retains storage charge. Cancel: duplicate cancellation/replay cannot refund twice. Overdue/month boundary: old-period reservation must not credit current month. | `video-mutation.ts`, `external-task-policy.ts`, D1/Postgres storage and mutation contract tests. No new billing policy is inferred. |
| HS3 Manual edit versus delayed completion | Decided: accepted current revision wins; preparation state belongs to current revision. | Normal: current publication becomes ready. Failure: current index failure remains visible as failure. Cancel: stale completion cannot replace accepted manual source. Overdue: old readiness timestamp does not stop current revision's 15m clock. | source/run fences in `transcription-policy.ts`, `scene-index-execution.ts`, hydration; evaluator stale revision test. |
| HS4 Removal versus delayed completion | Decided: logical deletion immediately denies access. Active object/index cleanup <=24h; notify >1h; incident >24h. Backups follow separate retention policy. | Normal: delete hides evidence immediately. Failure: physical cleanup retries without restoring visibility/refunding storage prematurely. Cancel: late PUT/completion cannot resurrect access. Overdue: >1h warning, >24h incident; equality boundary tested. | `video-mutation.ts`, `scene-retrieval.ts`, cleanup outbox; local recovery adversarial deleted evidence check and evaluator cleanup tests. Deletion-origin physical cleanup facts and notifications implemented for cloud D1; production delivery and residue scans remain unverified. |
| HS5 Retry versus new operation | Existing identity safety retained; replay process decision remains operationally constrained. No new blanket external resend permission. Same identity only for compatible failed/expired attempts, never completed/busy/conflicting/stale work. Unknown external outcome requires provider reconciliation first. | Normal: retry failed same identity once. Failure: conflicting payload refused. Cancel: completed/deleted work not resurrected. Overdue: expired lease must be reacquired; old lease cannot complete. | `job-repository.ts`, recovery inspection/restart tooling owned by background worker; local recovery duplicate/conflict/stale lease checks. `yukiharada1228` reviews any unresolved provider outcome at the same review date. |

## Monitoring contract

`apps/api/scripts/acceptance/evaluate-policy.mjs` accepts a sanitized JSON snapshot with `observedAt`, `readiness` and `cleanup` arrays, and emits events for the decided thresholds.
Each readiness row has `id`, `currentRevision`, `transcriptAcceptedAt`, optional `readyRevision`/`readyAt`; each cleanup row has `id`, `scope` (`active-object`, `active-index`, `backup`), `logicalDeletedAt`, optional `completedAt`.
A stale ready revision never satisfies current readiness. Completed late operations retain target-miss evidence; completed cleanup does not generate a pending notification. Invalid/future/misordered times fail closed.

```
node --test apps/api/scripts/acceptance/evaluate-policy.test.mjs
node apps/api/scripts/acceptance/evaluate-policy.mjs sanitized-snapshot.json
```

The CLI evaluator performs no network send. The runtime collector uses `policy_readiness` and deletion-origin `policy_cleanup` facts created atomically by D1 migration 0021. It hooks the existing maintenance sweep/scheduler and delivers sanitized events through `OPERATIONAL_POLICY_WEBHOOK_URL` (HTTPS) plus secret `OPERATIONAL_POLICY_WEBHOOK_TOKEN`. The receiver must enforce `Idempotency-Key`; the durable notification lease suppresses concurrent sends, and unknown outcomes may be retried with the same key. No source text, storage key, session, email or raw resource identifier is sent. Delivery errors are masked and retried after five minutes. The owner field is `yukiharada1228`; routing that account to a real operator destination remains deployment configuration, not an invented email address.

Existing current revisions are deliberately not assigned invented historical acceptance times. Observation begins with a newly accepted manual transcript or worker transcription receipt. Cleanup facts apply to pending object/index tasks durably associated with logical video deletion; unrelated reindex cleanup is not labeled deletion. Completed pre-deletion tasks are excluded. PostgreSQL/onprem does not share D1's source-revision/publication model and explicitly reports unsupported observation; it requires a separately verified lifecycle adapter.

Isolated D1 tests cover receipt gating/reset, current readiness, deletion-origin association, physical completion, concurrent delivery, persistent deduplication, error retry, privacy, invalid target rejection and threshold boundaries. Production deployment, configured operator destination, and acknowledgement remain unverified; #1684 is **policy decided / runtime implemented / production routing not accepted** until those are evidenced.

RPO/RTO, production RAG SLO, backup retention duration, and transcribe completion guarantees are not established by these decisions. Keep their acceptance cells open. Review records must include the responsible account, decision/effective date, evidence link, changed promise, affected state display/monitor/test, and next review date; do not silently replace these targets with observed synthetic timings.

## Migration and recovery of observations

The PG-to-D1 migration manifest treats all three policy tables as target-only:
readiness starts empty without historical acceptance backfill; cleanup starts
empty and observes future logical deletions; delivery deduplication starts empty
for those new facts. Creating empty tables is not evidence that existing sources
met a target or that historical deletions were physically cleaned. Same-D1
backup/restore must preserve all three tables together with source and outbox
state; dropping the notification ledger while retaining old facts can resend
operator notifications. D1-to-PG rollback has no equivalent source-fact adapter:
retain these facts and delivery receipts as a protected operational artifact,
and explicitly reconcile them before enabling a different monitoring adapter.

An intentional empty/ASCII-whitespace-only transcript has no searchable-content
expectation: an accepted clear removes its previous readiness clock atomically.
An empty successful worker transcript has the same monitoring treatment. A
nonempty accepted transcript, including malformed input that fails indexing,
keeps its current clock and remains observable as failure/overdue; this does not
promise that invalid content becomes searchable.

Readiness evidence binds the current accepted revision to its published physical run, configured dimensions and embedding fingerprint. Publication alone is insufficient: each current scene must have an accepted, ANN-verified completed upsert. A completed-status manual reindex uses the same observation path; superseded source clocks do not schedule maintenance. No historical acceptance or readiness is backfilled.
