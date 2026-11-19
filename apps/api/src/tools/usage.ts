import type { ProviderCallKind } from "../persistence/contracts/answer-cost-repository";

/** Provider usage sink; tools do not depend on an agent or an answer ledger. */
export interface UsageRecorder {
  begin(kind: ProviderCallKind, model: string): {
    complete(usage?: unknown): void;
    fail(usage?: unknown): void;
    interrupt(usage?: unknown): void;
  };
}
