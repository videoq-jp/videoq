import { AnswerTextService } from "../features/chat/answer-text-service";
import { StructuredAnswerError, assertAnswerHasText } from "../application/answer-generation";
import { z } from "zod";
import { parsePartialJson } from "@langchain/core/output_parsers";
import { modelAnswerSchema, type ModelAnswer } from "@videoq/trpc/chat";
import { isAIMessage, type BaseMessage } from "@langchain/core/messages";
import { LlmProviderError } from "./openai";

export const answerResponseFormat = {
  type: "json_schema" as const,
  json_schema: { name: "videoq_answer", strict: true, schema: z.toJSONSchema(modelAnswerSchema) },
};

export function assertCompletedAnswer(message: BaseMessage | undefined): void {
  if (!message || !isAIMessage(message) || message.tool_calls?.length || message.invalid_tool_calls?.length
    || message.additional_kwargs.refusal || message.response_metadata.finish_reason !== "stop") {
    throw new LlmProviderError("Structured answer refused or incomplete.");
  }
}

export function parseModelAnswer(text: string): ModelAnswer {
  try {
    const answer = modelAnswerSchema.parse(JSON.parse(text));
    assertAnswerHasText(answer);
    return answer;
  } catch {
    throw new LlmProviderError("Invalid structured answer.");
  }
}

/** Preserve the public provider error type outside application code. */
export function adaptStructuredAnswerFailure<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof StructuredAnswerError) throw new LlmProviderError(error.message);
    throw error;
  }
}

/** Compose SDK decoding with the framework-independent text state machine. */
export class AnswerTextStream extends AnswerTextService {
  constructor() {
    super({ decodePartial: parsePartialJson, decodeComplete: text => modelAnswerSchema.parse(JSON.parse(text)), decodeFinal: parseModelAnswer });
  }
  override completedSegments(): ModelAnswer['segments'] {
    return adaptStructuredAnswerFailure(() => super.completedSegments());
  }
  override push(delta: string): Array<{ segmentIndex: number; text: string }> {
    return adaptStructuredAnswerFailure(() => super.push(delta));
  }
  override finish(): ModelAnswer {
    return adaptStructuredAnswerFailure(() => super.finish());
  }
}
