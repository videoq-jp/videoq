# Scoped isolated evidence

See [the experiment report](../../current-configuration-experiments-2026-11-25.md) for reproduction, frozen source/config identities, results and acceptance limits. No passwords, cookies, SQL exports or full provider logs belong here. CHECKSUMS.sha256 covers these public files and the report.

| File | Evidence and scope |
| --- | --- |
| cloud-receipt.json | Sequential real-cloud operations, source/config hashes, exploratory failures and final recovery/measurement/cleanup phases. Failures are retained, not pooled into successful latency results. |
| recovery-summary.json | Final source 99ba6fbe; real D1 Time Travel and exact R2/vector restoration, measured loss window/resume, unapproved production RPO/RTO null. Managed Queue/Workflow state was retained, not portably restored. |
| rag-final-summary.json | Source 176ce1d1, 30 actual-provider authenticated RAG requests across six cells; all HTTP and bounded actual-citation quality assertions pass. Four warm observations per cell cannot establish reliable tail SLOs. |
| rag-invalid-config-summary.json, rag-filter-boundary-summary.json | Separate failed configurations/filter boundary runs; not mixed with final results. The earlier citation assertion counted retrieved registry entries rather than actual citations. |
| effective-config.json | Safe effective config/bindings; private paths replaced. Recovery injection vectors are deterministic; final RAG uses separately recomputed genuine model vectors and exact-value/ANN provenance checks. |
| d1-insights-exact.json | Authoritative fixed 02/03 UTC hourly-window top-20 SQL-group analytics, filter/query hashes, aggregate coverage limits. Not per-request attribution or all-database totals. |
| d1-insights.json | Earlier rolling-window exploratory analytics; not substituted for the exact-window receipt. |
| filter-probe.json | Actual independent provider list-count/normalized-byte boundary responses. |
| notification-outbox-verification.json | Separate HTTPS sink delivery, durable notification dedup and outbox once-only completion. A direct transport probe is separately labeled. Synthetic aged cleanup fact is not a real deletion timing observation. |
| deletion-replay-verification.json, stale-index-proof.json | Actual deletion/replay, stable job attempts and stale ANN-visible vector excluded by authenticated scoped search. |
| cleanup-verification.json | All active resources absent; Vectorize explicitly deleted tombstone (410/code3005). Does not prove provider-internal backup erasure. |
| provider-boundary-findings.json | Actual provider/runtime boundaries and resolved cleanup guards. |
| current-recovery-local.json, current-rag-local.json | Source c7a764ed local disposable binding experiments; simulation fidelity explicitly listed. These are separate from cloud proof. |

The final matrix has 310 D1 query calls and zero calls exposing rows-read metadata. Raw trace `reads: 0` means the sum over an empty observed subset; total rows-read is unknown/null, not zero. The final summary gives the unavailable denominator. Exact-window Insights instead reports 2040 executions and 84046 rows read within selected SQL groups across setup/recovery/maintenance/RAG; no request-level allocation is claimed.

Remaining production criteria, including RPO/RTO approval, notification routing/human acknowledgement, portable managed-state recovery and production-density/cold/tail measurements, remain explicit in the report. These receipts do not close those gaps or claim production policy achievement.
