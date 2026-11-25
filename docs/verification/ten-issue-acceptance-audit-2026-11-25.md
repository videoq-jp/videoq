# Issue 1675–1684 acceptance audit

Snapshot source: `fb075224813219bd59500dd761c949af43d3febb`. This is a requirement audit, not an issue-closure or deployment claim. Live CI and paired measurements must be assessed again after completion.

Original scope: 30 checkboxes; 25 proved, 4 pending, 1 missing at this snapshot. Issue 1674 is excluded.

## #1675 — [P1] 失敗した検索Workflowの復旧手順とツールを整備する

- **Proved**: 失敗・終了済みWorkflowの復旧を隔離環境で実証する
  Actual local workerd SearchIndexWorkflow terminal failure and explicitly terminated instance both restart and complete; deployed isolated native admin/cloud Workflow additionally exercised terminal recovery.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/search-workflow-recovery-local-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/persistence/search-workflow-recovery.integration.test.ts#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/cloud-receipt.json#L1)

- **Proved**: 実行中の別処理や古いsourceを上書きしない
  Review digest and lease/source/artifact/config fences reject active/completed/conflicting/stale work; changed source/model/origin and artifact guards exercised.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/persistence/search-recovery-guards.integration.test.ts#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/search-workflow-recovery-local-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/src/integrations/background-jobs/recovery.ts#L1)

- **Proved**: 再起動前後の副作用・job台帳・成果物を照合し、監査記録と手順を残す
  Before/after ledger, one head, artifacts cleanup, retained content-free audit and runbook are recorded; cloud outbox intent completed once and duplicate deliveries did not create a new run.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/search-workflow-recovery-local-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/search-workflow-recovery.md#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/notification-outbox-verification.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/deletion-replay-verification.json#L1)


## #1676 — [P1] 埋め込みモデルの互換性を索引のfingerprintで検査する

- **Proved**: 同次元で異なるモデルまたは前処理の設定を不一致として検出する
  Canonical TS/Python identity includes provider/model/revision/profile/dimensions/prefix/preprocessing; same-dimension model/revision/preprocessing changes mismatch.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/validation/embedding-fingerprint-issue1676-report.md#L10), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/persistence/embedding-fingerprint.d1.integration.test.ts#L28)

- **Proved**: 不一致時に検索・登録を安全に拒否する
  Strict writer stage/publish, query/hydration and asynchronous upsert gates reject unknown/mismatched identity; real D1 and PostgreSQL tests cover rejection.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/validation/embedding-fingerprint-issue1676-report.md#L10), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/persistence/embedding-fingerprint.d1.integration.test.ts#L36), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/src/persistence/postgres/transcript-index-writer.ts#L1)

- **Proved**: 既存索引の互換判定、再生成、段階移行を試験する
  Legacy nullable provenance is not invented/backfilled; D1 old-schema/writer cutover/rebuild and built-node real PG paused rebuild/resume/changed-revision refusal tested.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/validation/embedding-fingerprint-issue1676-report.md#L10), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/validation/embedding-fingerprint-onprem-2026-11-25.json#L1)


## #1677 — [P1] 現行768次元構成の統合復旧を隔離環境で実証する

- **Proved**: 候補SHA・設定digest・snapshot・モデルを固定する
  Recovery source99ba6fbe/config digest/snapshot hash/bookmark/768 model identity fixed. Deterministic failure-injection Workflow vectors distinguished from actual Gemma recomputation and exact-value/ANN readiness.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/recovery-summary.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/effective-config.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/current-configuration-experiments-2026-11-25.md#L96)

- **Proved**: 欠損・重複・削除・権限・外部副作用の再送可否を照合する
  Actual D1/R2/vector missing/corruption restoration, duplicate delivery, logical deletion against ANN-visible stale vector, foreign-owner denial, durable outbox dedup and unknown-outcome deferral recorded. Managed Queue/Workflow state retained in the same isolated services; no portable account-loss restore claim.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/cloud-receipt.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/stale-index-proof.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/deletion-replay-verification.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/notification-outbox-verification.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/current-recovery-local.json#L1)

- **Missing**: 復旧所要時間とデータ損失範囲を測り、承認済みRPO/RTOとの比較と対象外を記録する
  Measured2082ms D1 restore,12227ms known synthetic post-snapshot write window,81581ms admitted resume,261348ms first actual-model readiness; exclusions explicit. However approved production RPO/RTO are null, so the explicitly requested approved-target comparison has not occurred.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/recovery-summary.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/current-configuration-experiments-2026-11-25.md#L96)
  Remaining: Responsible business/operations authority must decide and approve applicable RPO/RTO and recovery boundary, then compare recorded measurements with those targets; do not retroactively call observations approved targets. A smaller target may require additional isolated engineering/measurement.

## #1678 — [P1] オンプレCIのイメージビルド時間を実測に基づいて短縮する

- **Pending**: 変更前後を同条件で複数回計測する
  Earlier repeated parallelism experiment explicitly fails strict comparability and does not establish shortening. New same-runner fresh-builder baseline/candidate three-pair experiment is live, not failed, and has not supplied completed timing receipts.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/onprem-build-comparison-2026-11-25/receipt.json#L254), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/workflows/onprem-paired-builds.yml#L1), [source](https://github.com/videoq-jp/videoq/actions/runs/45542395983)
  Remaining: When existing run finishes, collect unaltered paired reports, validate same conditions/counterbalanced order, compare repeated cold/warm times and demonstrate actual shortening; if no benefit, further executable optimization remains required by this issue.
- **Pending**: 同じ候補の成果物・脆弱性検査・必須チェックを維持する
  Previous measured-image IDs match smoke/SBOM/scanned inputs and mandatory gates remain wired. New OpenSSL candidate exact-image checks and current normal CI are still running, so do not transfer old artifact success to the current candidate.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/onprem-build-comparison-2026-11-25/receipt.json#L254), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/workflows/onprem-paired-builds.yml#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/actions/check-measured-application-images/action.yml#L1), [source](https://github.com/videoq-jp/videoq/actions/runs/45542894484)
  Remaining: Collect completed current paired exact-image smoke/security receipts and normal required checks, retaining SHA/image identity and failures.
- **Pending**: キャッシュの信頼境界と無効化条件を検証し、時間・費用・失敗率を比較する
  Local-only cache trust boundary and previous same/changed-input controls are evidenced. New shared OpenSSL graph/compiler-cache/invalidation controls plus comparable time/runner-second/failure comparison await the live paired run.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/onprem-build-comparison-2026-11-25/receipt.json#L254), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/workflows/onprem-paired-builds.yml#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/scripts/openssl-cache-invalidation.py#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/scripts/check-openssl-cache.py#L1)
  Remaining: Inspect real invalidation artifact, cache lineage and time/runner-second/failure totals from existing run; no currency budget approval is required to compare runner seconds honestly.

## #1679 — [P2] 失敗分類をログ・ジョブ台帳・DB実装間で統一する

- **Proved**: 429・DB停止・source変更・不正字幕・期限超過を許可リストのコードで判別する
  Allowlisted provider429, nested SQLSTATE/D1 DB outage, source change, invalid transcript and deadline codes exist and are exercised, including actual Workflow RPC marker handling.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/background-job.test.ts#L51), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/src/application/job-failure.ts#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/search-workflow-recovery-local-2026-11-25.json#L1)

- **Proved**: ログと台帳で同じ原因を追跡できる
  Shared classifier feeds transport diagnostics and job repository failure code; D1/PG allowlist persistence contracts and actual refused PostgreSQL connection/RPC classification recorded.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/background-job.test.ts#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/sqs-background-diagnostics.test.ts#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/search-workflow-recovery-local-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/src/persistence/postgres/transcript-index-writer.ts#L78)

- **Proved**: 既存の再試行・DLQ・秘密情報非出力の挙動を維持する
  Retry/busy/conflict semantics and no-ACK visibility behavior maintained; allowlist replacement and forged/unknown provider markers prevent raw secrets entering logs/ledger.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/search-workflow-recovery-local-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/sqs-background-diagnostics.test.ts#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/background-job.test.ts#L1)


## #1680 — [P2] SQS可視性変更の失敗を独立したイベントとして観測する

- **Proved**: 処理失敗とChangeMessageVisibility失敗の同時発生を障害注入で検証する
  Simultaneous provider failure and ChangeMessageVisibility failure injection explicitly asserts only ReceiveMessage/ChangeMessageVisibility, no DeleteMessage.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/sqs-background-diagnostics.test.ts#L42), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/search-workflow-recovery-local-2026-11-25.json#L1)

- **Proved**: message/job IDと安全なコードから両方の失敗を区別する
  Two events preserve job/message IDs and original provider code; visibility event has independent VISIBILITY_CHANGE_FAILED code.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/sqs-background-diagnostics.test.ts#L56), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/src/integrations/background-jobs/sqs-consumer.ts#L47)

- **Proved**: ReceiptHandle・payload・資格情報・例外生文字列をログへ出さない
  Injected private receipt/payload/provider/credential markers are absent from both serialized events; allowlisted diagnostics replace raw exception text.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/sqs-background-diagnostics.test.ts#L57), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/src/integrations/background-jobs/diagnostics.ts#L1)


## #1681 — [P2] 配備済み旧Consumerと新Producerの互換試験をリリース条件にする

- **Proved**: 検証対象の旧版と新版をdigest/SHAで特定する
  Old API1d97335b and Python12a5e668 pinned to successful deployment receipts; candidate1620d1a2 frozen in retained receipt. Current fb075224 delivery gate also succeeded in normal CI. Source pin rather than customer-installed image claim is explicit.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/release-compatibility-ci-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/delivery-ci-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/release-compatibility.json#L1), [source](https://github.com/videoq-jp/videoq/actions/runs/45542894484/job/138965562526)

- **Proved**: 受理・拒否・canonical hash・再配送・完了済み副作用を照合する
  16 real old/new TS/Python producer-consumer combinations×58 cases check accept/reject/canonical bytes/hash and completed redelivery effect count1; negative hash/replay/rejection controls prove gate failure. In-memory execution barrier scope explicitly disclosed.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/release-compatibility-ci-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/scripts/release-compatibility.mjs#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/delivery-ci-2026-11-25.json#L1)

- **Proved**: 不互換な変更を混在配備しないことをリリース手順とゲートで保証する
  Always-selected delivery gate required by CI Success, exact-main source validation gates release, incompatible mixes require dedicated routing/drain migration; no accept-incompatibility bypass.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/delivery-regression.md#L38), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/workflows/delivery-regression.yml#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/workflows/ci.yml#L112)


## #1682 — [P2] CORS実ブラウザー受入試験を継続的な回帰検査にする

- **Proved**: 許可10・不許可5項目をブラウザー保護を無効化せず実行する
  Actual Chromium default protections ran existing allowed10/denied5 fixtures; allPassed true and current delivery gate success. Full OAuth/TLS/CDN is explicitly outside original issue scope.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/cors-browser-ci-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/delivery-ci-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/actions/runs/45542894484/job/138965562526)

- **Proved**: 不許可JSON POST/署名PUTの本体未送信をサーバー側でも検査する
  Server traces verify deniedApiPostAbsent/deniedStoragePutAbsent and rejected storage preflight.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/cors-browser-ci-2026-11-25.json#L12), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/scripts/cors-regression.mjs#L1)

- **Proved**: multipart ETag・組立bytes・APIエラー読取り・MCP資格情報モードを維持し、失敗時にCIを落とす
  Multipart exposed ETags, two parts,5242917-byte assembled hash, API500 readability and MCP credential modes all pass; missing/partial/failed report exits nonzero in required CI.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/verification/cors-browser-ci-2026-11-25.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/.github/workflows/delivery-regression.yml#L50), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/scripts/cors-regression.mjs#L1)


## #1683 — [P2] 認証込みの現行RAG性能を分解計測して次のDB改善対象を選ぶ

- **Proved**: SHA・設定・データ分布・配置・標本数・並行度を固定する
  Real authenticated actual RAG source176ce1d1/config/resources/question fixed; corpus distribution1000 metadata rows/two transcript scenes, placement, six1/100/1000×concurrency1/2 cells and30 samples recorded. Cold is logical harness cold, not guaranteed provider-isolate cold.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/rag-final-summary.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/effective-config.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/current-configuration-experiments-2026-11-25.md#L96)

- **Pending**: p50/p95/p99・失敗率・処理回数・DB読取り量を記録する
  p50/p95/p99, errors and operation counts recorded;310query calls with0metadata-covered/310unavailable and total workload rows-read null. Provider exact-hour top20SQL groups records2040executions/84046rows-read but includes setup/recovery/maintenance, so this is not a quantified DB read amount attributable to the frozen RAG matrix.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/rag-final-summary.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/d1-insights-exact.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/current-configuration-experiments-2026-11-25.md#L96)
  Remaining: Executable isolated instrumentation/window experiment can expose D1 result metadata or collect a non-overlapping workload-only aggregate and quantify coverage. Original issue does not demand exact per-trace billing, statistically stable p99, or production volume, so do not add those as independent blockers; retain this narrowly as workload DB-read amount not yet quantified.
- **Proved**: 認可・検索品質を維持し、SQL等の変更は前後比較と書込み/容量コストで判断する
  Owner/foreign/deletion authorization and30/30bounded actual-citation quality checks pass. Answer provider dominates observed spans; no SQL/index/write/schema change proposed. Provider filter correction failure-to-pass and increased query cost10partition calls/1000scope explicit; no invented SQL improvement.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/rag-final-summary.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/filter-probe.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/stale-index-proof.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/current-configuration-experiments-2026-11-25.md#L96)


## #1684 — [P2] 業務モデルの未決事項を実担当者・期限・受入試験へつなげる

- **Proved**: 各論点の確認先・決定状態・期限を追跡できる
  All five original Hot Spots HS1..HS5 mapped to actual responsible/review account yukiharada1228, decision/operationally constrained status, decision date2026-11-25 and review deadline2026-12-02; delegated authority evidenced in issue comment.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/business-decisions-2026-11-25.md#L10), [source](https://github.com/videoq-jp/videoq/issues/1684#issuecomment-7150223723), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/architecture/bpmn.md#L119)

- **Proved**: 正常/失敗/取消/期限超過の代表例で利用者への約束を確認する
  Register maps normal/failure/cancel/overdue cases for readiness, refunds/month boundaries, manual edit/stale work, deletion and retry identity; exact acceptance/source and physical-cleanup timing, empty-clear and completed-status reindex regression tests cover promises.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/business-decisions-2026-11-25.md#L10), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/persistence/operational-policy.d1.integration.test.ts#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/scripts/acceptance/evaluate-policy.test.mjs#L1)

- **Proved**: 合意した内容をコード・監視・試験へ対応付け、未合意の数値を捏造しない
  Delegated15m readiness/24h active cleanup with1h warning wired to durable fact collector, maintenance scheduler and private idempotent HTTPS notification adapter; real isolated delivery once/repeat0 and tests documented. Production recipient rollout is not a new condition required by original checkbox once implemented/tested isolated monitoring is evidenced; no RPO/RTO approval inferred.
  Evidence: [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/business-decisions-2026-11-25.md#L10), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/docs/operations/evidence/2026-11-25-current/notification-outbox-verification.json#L1), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/src/features/maintenance/service.ts#L82), [source](https://github.com/videoq-jp/videoq/blob/fb075224813219bd59500dd761c949af43d3febb/apps/api/test/persistence/operational-policy.d1.integration.test.ts#L1)


## Scope limits

- Production deploy/notification routing/human acknowledgement is not independently required by original #1684 completion checkboxes; distinguish implemented isolated monitoring from live rollout.
- Portable account-loss Queue/Workflow checkpoint restoration, backup-retention agreement and physical provider backup erasure are not explicitly required; retain same-resource platform-state fidelity exclusions without claiming portable restoration.
- Production RAG latency/cost SLO approval, production-density corpus, guaranteed provider-isolate cold starts, statistically reliable p99 or exact per-trace bill allocation are not additional original #1683 requirements; small sample and read-coverage limits must stay explicit.
- Customer-installed on-prem version census and full OAuth/TLS/CDN acceptance are not required by #1681/#1682 source-pinned wire/browser regression scope.
- #1677 approved RPO/RTO comparison and #1678 same-condition actual shortening are explicit requirements, not optional future rollout caveats.

RPO/RTO approval is pending; the coordinator has requested an explicit decision. No proposed numeric target is treated as approved by this audit.
