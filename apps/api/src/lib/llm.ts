import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createChatModel, toLlmError } from "./chat-model";
import { answerResponseFormat, AnswerTextStream, assertCompletedAnswer, parseModelAnswer } from "./structured-answer";
import type { ModelAnswer } from "@videoq/trpc/chat";
import { deadlineSignal } from "./request-timeout";
import type { Bindings } from "../types/bindings";
import type { AnswerCostLedger } from "./answer-cost-ledger";
import { LlmConfigurationError } from "./openai";

/**
 * QA RAG の LLM 呼び出し。temperature=0.0、max_tokens=1024 を使う。
 * プロンプトは system + human の 2 通のみで、
 * 会話履歴は渡さない（`ChatPromptTemplate.from_messages([system, human])`）。
 */
export const MAX_TOKENS = 1024;
export const LLM_REQUEST_TIMEOUT_MS = 2 * 60_000;
export const LLM_STREAM_TIMEOUT_MS = 5 * 60_000;

export function llmTimeoutMs(env: Bindings, streaming = false): number {
  const key = streaming ? "LLM_STREAM_TIMEOUT_MS" : "LLM_REQUEST_TIMEOUT_MS";
  if (!env[key]) return streaming ? LLM_STREAM_TIMEOUT_MS : LLM_REQUEST_TIMEOUT_MS;
  const value = Number(env[key]);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 900_000) {
    throw new LlmConfigurationError(`${key} must be an integer between 1000 and 900000`);
  }
  return value;
}

const promptMessages = (systemPrompt: string, queryText: string) => [
  new SystemMessage(systemPrompt),
  new HumanMessage(queryText),
];

/** 非ストリーミング（`llm.invoke`）。検証済みの構造化回答を返す。 */
export async function generateReply(
  env: Bindings,
  systemPrompt: string,
  queryText: string,
  costLedger?: AnswerCostLedger,
): Promise<ModelAnswer> {
  const model = createChatModel(env, {
    maxTokens: MAX_TOKENS,
    timeoutMs: llmTimeoutMs(env),
    costLedger,
  });
  try {
    const message = await model.invoke(promptMessages(systemPrompt, queryText), { response_format: answerResponseFormat });
    assertCompletedAnswer(message);
    return parseModelAnswer(message.text);
  } catch (error) {
    throw toLlmError(error);
  }
}

/**
 * ストリーミング（`llm.streamEvents`）。segmentごとの本文差分と、最後に検証済み回答を返す。
 *
 * `signal` にはクライアント接続の中断シグナルを渡す。切断後も OpenAI からの
 * 受信を続けるとサーバー側キーの課金だけが進むため、上流ごと止める。
 */
export async function* streamReply(
  env: Bindings,
  systemPrompt: string,
  queryText: string,
  signal?: AbortSignal,
  costLedger?: AnswerCostLedger,
): AsyncGenerator<{ segmentIndex: number; text: string } | { answer: ModelAnswer }> {
  const model = createChatModel(env, {
    maxTokens: MAX_TOKENS,
    timeoutMs: llmTimeoutMs(env, true),
    costLedger,
  });
  // SDK の timeout は SSE 本文の受信を保護しないため、受信完了まで期限を保つ。
  const lifecycle = new AbortController();
  const requestSignal = AbortSignal.any([
    deadlineSignal(llmTimeoutMs(env, true), signal),
    lifecycle.signal,
  ]);
  try {
    const stream = model.streamEvents(promptMessages(systemPrompt, queryText), {
      signal: requestSignal,
      response_format: answerResponseFormat,
    });
    const parser = new AnswerTextStream();
    for await (const text of stream.text) {
      requestSignal.throwIfAborted();
      for (const delta of parser.push(text)) yield delta;
    }
    // SDK が中断を正常なストリーム終端として返す場合も成功にはしない。
    requestSignal.throwIfAborted();
    assertCompletedAnswer(await stream);
    yield { answer: parser.finish() };
  } catch (error) {
    throw toLlmError(error);
  } finally {
    lifecycle.abort();
  }
}
