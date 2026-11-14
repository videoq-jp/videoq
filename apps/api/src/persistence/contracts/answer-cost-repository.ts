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
export type AnswerCostStart = {
    id: string;
    planCode: string;
    quotaSource: string;
    hasCourse: boolean;
    streamed: boolean;
};
export type AnswerCostFinish = {
    status: AnswerAttemptStatus;
    quotaConsumed: boolean;
    providerCalls: readonly ProviderCallRecord[];
};
/** Anonymous billing metadata only. Finishing is an atomic started -> terminal
 * transition; retries must never replace an already recorded outcome. */
export interface AnswerCostRepository {
    start(input: AnswerCostStart): Promise<void>;
    finish(id: string, outcome: AnswerCostFinish): Promise<void>;
}
