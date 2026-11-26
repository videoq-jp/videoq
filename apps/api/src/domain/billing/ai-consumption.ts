/** Existing products promise different consumption milestones. Keep the
 * distinction explicit; provider cost is not the same as a delivered answer. */
export type AiConsumptionEvidence =
  | { kind: 'completed_answer' }
  | { kind: 'failed_answer'; committed: boolean }
  | { kind: 'interrupted_stream'; textGenerated: boolean }
  | { kind: 'provider_work'; calls: readonly { status: string }[] };

export function aiQuotaConsumed(evidence: AiConsumptionEvidence): boolean {
  switch (evidence.kind) {
    case 'completed_answer': return true;
    case 'failed_answer': return evidence.committed;
    case 'interrupted_stream': return evidence.textGenerated;
    case 'provider_work': return evidence.calls.some(call => call.status === 'completed');
  }
}
