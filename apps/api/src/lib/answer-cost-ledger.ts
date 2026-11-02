import { withClient } from "../db/pool";
import type { Bindings } from "../types/bindings";

export type ProviderCallKind = "answer_model" | "conversation_summary" | "visual_inspection" | "query_embedding";
export type ProviderCallStatus = "completed" | "failed" | "interrupted";
export type AnswerAttemptStatus = "completed" | "failed" | "interrupted";

export type ProviderCallRecord = {
  kind: ProviderCallKind;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  status: ProviderCallStatus | "started";
  usage: Record<string, unknown> | null;
};

/** Keep numeric billing counters only; never persist prompts, responses, or request headers. */
function numericUsage(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3 || typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) sanitized[key] = item;
    else {
      const nested = numericUsage(item, depth + 1);
      if (nested) sanitized[key] = nested;
    }
  }
  return Object.keys(sanitized).length ? sanitized : null;
}

/** One in-memory ledger per answer attempt, including calls on failed answers. */
export class AnswerCostLedger {
  readonly id = crypto.randomUUID();
  readonly calls: ProviderCallRecord[] = [];

  begin(kind: ProviderCallKind, model: string) {
    const call: ProviderCallRecord = {
      kind, model, startedAt: new Date().toISOString(), finishedAt: null,
      status: "started", usage: null,
    };
    this.calls.push(call);
    let finished = false;
    const finish = (status: ProviderCallStatus, usage?: unknown) => {
      if (finished) return;
      finished = true;
      call.status = status;
      call.finishedAt = new Date().toISOString();
      call.usage = numericUsage(usage);
    };
    return {
      complete: (usage?: unknown) => finish("completed", usage),
      fail: (usage?: unknown) => finish("failed", usage),
      interrupt: (usage?: unknown) => finish("interrupted", usage),
    };
  }
}

export async function startAnswerCostLedger(
  env: Bindings, ledger: AnswerCostLedger,
  scope: { planCode: string; quotaSource: string; hasCourse: boolean; streamed: boolean },
): Promise<void> {
  await withClient(env, client => client.query(
    `INSERT INTO ai_answer_attempts
      (id, plan_code, quota_source, has_course, streamed, status)
     VALUES ($1, $2, $3, $4, $5, 'started')`,
    [ledger.id, scope.planCode, scope.quotaSource, scope.hasCourse, scope.streamed],
  ));
}

export async function finishAnswerCostLedger(
  env: Bindings, ledger: AnswerCostLedger,
  outcome: { status: AnswerAttemptStatus; quotaConsumed: boolean },
): Promise<void> {
  // A worker/stream can stop before the provider iterator reports its outcome.
  // Keep such calls visible as incomplete rather than silently counting them as free.
  for (const call of ledger.calls) {
    if (call.status === "started") {
      call.status = "interrupted";
      call.finishedAt = new Date().toISOString();
    }
  }
  await withClient(env, client => client.query(
    `UPDATE ai_answer_attempts
        SET finished_at = clock_timestamp(), status = $2,
            quota_consumed = $3, provider_calls = $4::jsonb
      WHERE id = $1 AND status = 'started'`,
    [ledger.id, outcome.status, outcome.quotaConsumed, JSON.stringify(ledger.calls)],
  ));
}
