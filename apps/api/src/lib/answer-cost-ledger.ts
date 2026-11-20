import { AnswerCostLedgerState } from '../features/billing/cost-ledger';
import { createAnswerCostRepository } from "../persistence/factory";
import type { Bindings } from "../types/bindings";
import type {AnswerAttemptStatus} from '../persistence/contracts/answer-cost-repository';
export type {ProviderCallKind,ProviderCallStatus,AnswerAttemptStatus,ProviderCallRecord} from '../persistence/contracts/answer-cost-repository';

/** Runtime defaults retain the public per-answer ledger API. */
export class AnswerCostLedger extends AnswerCostLedgerState {
  constructor() { super({ newId: () => crypto.randomUUID(), now: () => new Date().toISOString() }); }
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
  ledger.interruptPending();
  const repository = await createAnswerCostRepository(env);
  await repository.finish(ledger.id,{...outcome,providerCalls:ledger.calls});
}
