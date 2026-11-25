# Approved recovery targets and isolated comparison

On 2026-11-25 JST, the project owner explicitly approved in the coordinator conversation: 「RPO15分・RTO60分を承認する」.

The approved RPO is 900,000ms of tolerable data loss. The approved RTO is 3,600,000ms until search can resume. These are operational targets, not a guarantee demonstrated at production scale.

The frozen [isolated recovery receipt](evidence/2026-11-25-current/recovery-summary.json) records the following comparison:

| Measure | Observed | Approved target | Result in this fixture |
| --- | ---: | ---: | --- |
| Known synthetic post-snapshot loss window | 12,227ms | RPO 900,000ms | Within target |
| Restore start to first observed genuine model value and ANN readiness | 261,348ms | RTO 3,600,000ms | Within target |

The RTO comparison uses actual model readiness, rather than only the 2,082ms D1 restore or 81,581ms traffic admission. Operator sequencing and provider propagation are included in the observed readiness interval. Incident detection and pre-restore decision time were not measured, so this comparison does not establish incident-to-recovery production RTO.

The fixture restored eight synthetic R2 objects and two current 768-dimensional vectors. One new outbox intent was intentionally lost and one corruption write reverted. Managed Queue/Workflow state remained in the same isolated services; portable reconstruction and production-volume recovery were not tested. The known synthetic loss interval does not establish a maximum loss bound for arbitrary production writes or backup schedules.

The original raw receipt retains null approval fields because targets were not approved when it was captured. This subsequent decision supplies the approved-target comparison required by #1677 without rewriting historical observations. Production mutation or a new recovery exercise was not performed for this approval.
