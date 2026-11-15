import { createAnswerCostRepository } from "../persistence/factory";
import type { Bindings } from "../types/bindings";
import type {ProviderCallKind,ProviderCallStatus,AnswerAttemptStatus,ProviderCallRecord} from '../persistence/contracts/answer-cost-repository';
export type {ProviderCallKind,ProviderCallStatus,AnswerAttemptStatus,ProviderCallRecord} from '../persistence/contracts/answer-cost-repository';

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
  const repository = await createAnswerCostRepository(env);
  await repository.start({id:ledger.id,...scope});
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
  const repository = await createAnswerCostRepository(env);
  await repository.finish(ledger.id,{...outcome,providerCalls:ledger.calls});
}
