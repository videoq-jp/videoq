import { executeExternalEvidence } from '../features/evidence/external-service';
import { getCourseWithMembers } from '../repositories/chat-repository';
import { reserveAiAnswerUsage, releaseAiAnswerReservation } from '../repositories/quota-repository';
import { AnswerCostLedger, startAnswerCostLedger, finishAnswerCostLedger } from '../lib/answer-cost-ledger';
import { enforceThrottles } from '../lib/rate-limit';
import { deadlineSignal } from '../lib/request-timeout';
import { createEvidenceSession } from '../tools/session';
import type { ToolExecution } from '../tools/definition';
import type { Bindings } from '../types/bindings';

export function executeExternalEvidenceTool(env: Bindings, userId: string, courseId: number,
  tool: string, args: Record<string, unknown>, request: ToolExecution) {
  return executeExternalEvidence({
    readThrottle: () => enforceThrottles(env, [{ scope: 'mcp_read_user', ident: userId }]),
    course: id => getCourseWithMembers(env, { courseId: id, userId }),
    checkCancellation: () => request.signal.throwIfAborted(),
    evidenceThrottle: cost => enforceThrottles(env, [{ scope: 'mcp_evidence_user', ident: userId, cost }]),
    reserve: owner => reserveAiAnswerUsage(env, owner),
    release: reservation => releaseAiAnswerReservation(env, reservation),
    open(course) {
      const usage = new AnswerCostLedger(), lifecycle = new AbortController();
      const signal = deadlineSignal(180_000, AbortSignal.any([request.signal, lifecycle.signal]));
      const session = createEvidenceSession(env, { ownerUserId: course.userId, courseId: course.id, videoIds: course.memberVideoIds }, signal, { usage });
      return {
        startLedger: reservation => startAnswerCostLedger(env, usage, { planCode: reservation.planCode, quotaSource: reservation.quotaSource, hasCourse: true, streamed: false }),
        findTool(name) {
          const definition = session.tools.find(item => item.name === name);
          return definition ? input => definition.invoke(input, { ...request, signal }) : undefined;
        },
        interrupted: () => signal.aborted, abort: () => lifecycle.abort(), close: () => session.close(),
        providerCalls: () => usage.calls,
        finishLedger: outcome => finishAnswerCostLedger(env, usage, outcome),
      };
    },
    reportFailure: kind => console.error(JSON.stringify({ event: kind === 'quota_release' ? 'mcp_evidence_quota_release_failed' : 'mcp_evidence_usage_finish_failed' })),
  }, { courseId, tool, args });
}
