import type { AiAnswerReservation, AiAnswerReservationResult } from '../../persistence/contracts/ai-quota';
import type { LearningCourse } from '../../application/native-learning';
import type { ProviderCallRecord } from '../../persistence/contracts/answer-cost-repository';

export type ExternalEvidenceValue = string | Record<string, unknown>;
type ThrottleResult = { retryAfterSec: number } | null;
export interface ExternalEvidenceExecution {
  startLedger(reservation: AiAnswerReservation): Promise<void>;
  findTool(name: string): ((args: Record<string, unknown>) => Promise<ExternalEvidenceValue>) | undefined;
  interrupted(): boolean;
  abort(): void;
  close(): Promise<void>;
  providerCalls(): readonly Pick<ProviderCallRecord, 'status'>[];
  finishLedger(outcome: { status: 'interrupted' | 'completed' | 'failed'; quotaConsumed: boolean }): Promise<void>;
}
export interface ExternalEvidenceDependencies {
  readThrottle(): Promise<ThrottleResult>;
  course(courseId: number): Promise<LearningCourse | null>;
  checkCancellation(): void;
  evidenceThrottle(cost: number): Promise<ThrottleResult>;
  reserve(ownerUserId: string): Promise<AiAnswerReservationResult>;
  release(reservation: AiAnswerReservation): Promise<void>;
  open(course: LearningCourse): ExternalEvidenceExecution;
  reportFailure(kind: 'quota_release' | 'usage_finish'): void;
}

export function externalEvidencePlan(tool: string, args: Record<string, unknown>) {
  const visual = tool === 'inspect_clip' || tool === 'focus_clip' || args.include_visuals === true;
  return { paid: tool === 'search_scenes' || visual,
    cost: visual ? (tool === 'overview_video' || tool === 'focus_clip' ? 16 : 8) : 1 };
}

/** Reserve the account unit before paid work; completed provider calls determine consumption. */
export async function executeExternalEvidence(deps: ExternalEvidenceDependencies,
  input: { courseId: number; tool: string; args: Record<string, unknown> }): Promise<ExternalEvidenceValue> {
  const limited = await deps.readThrottle();
  if (limited) return { status: 'rate_limited', retry_after_seconds: limited.retryAfterSec };
  const course = await deps.course(input.courseId);
  deps.checkCancellation();
  if (!course) return { status: 'unavailable', message: 'Course is unavailable or access is denied.' };
  const plan = externalEvidencePlan(input.tool, input.args);
  if (plan.paid) {
    const throttled = await deps.evidenceThrottle(plan.cost);
    if (throttled) return { status: 'rate_limited', retry_after_seconds: throttled.retryAfterSec };
  }
  const quota = plan.paid ? await deps.reserve(course.userId) : undefined;
  if (quota && !('reservation' in quota)) return { status: 'quota_exceeded', message: 'AI usage quota is exhausted.' };
  const reservation = quota && 'reservation' in quota ? quota.reservation : undefined;
  const execution = deps.open(course);
  let succeeded = false, ledgerStarted = false;
  try {
    if (reservation) { await execution.startLedger(reservation); ledgerStarted = true; }
    const invoke = execution.findTool(input.tool);
    if (!invoke) return { status: 'unavailable', message: 'Tool is unavailable.' };
    const value = await invoke(input.args);
    succeeded = true;
    return value;
  } finally {
    const interrupted = execution.interrupted();
    execution.abort();
    await execution.close();
    const consumed = execution.providerCalls().some(call => call.status === 'completed');
    if (reservation && !consumed) {
      try { await deps.release(reservation); }
      catch { deps.reportFailure('quota_release'); }
    }
    if (ledgerStarted) {
      try { await execution.finishLedger({ status: interrupted ? 'interrupted' : succeeded ? 'completed' : 'failed', quotaConsumed: consumed }); }
      catch { deps.reportFailure('usage_finish'); }
    }
  }
}
