import type { ProviderCallKind, ProviderCallStatus, ProviderCallRecord } from '../../persistence/contracts/answer-cost-repository';

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
export class AnswerCostLedgerState {
  readonly id: string;
  constructor(private readonly deps: { newId(): string; now(): string }) { this.id = deps.newId(); }
  readonly calls: ProviderCallRecord[] = [];

  begin(kind: ProviderCallKind, model: string) {
    const call: ProviderCallRecord = {
      kind, model, startedAt: this.deps.now(), finishedAt: null,
      status: "started", usage: null,
    };
    this.calls.push(call);
    let finished = false;
    const finish = (status: ProviderCallStatus, usage?: unknown) => {
      if (finished) return;
      finished = true;
      call.status = status;
      call.finishedAt = this.deps.now();
      call.usage = numericUsage(usage);
    };
    return {
      complete: (usage?: unknown) => finish("completed", usage),
      fail: (usage?: unknown) => finish("failed", usage),
      interrupt: (usage?: unknown) => finish("interrupted", usage),
    };
  }

  interruptPending(): void {
    for (const call of this.calls) {
      if (call.status === 'started') {
        call.status = 'interrupted';
        call.finishedAt = this.deps.now();
      }
    }
  }

}

