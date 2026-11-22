import { OpenAIEmbeddings } from "@langchain/openai";
import { workersAiEmbeddingFetch } from "./workers-ai-embedding-transport";
import {
  LlmConfigurationError,
  LlmProviderError,
  openAiBaseUrl,
  resolveOpenAiKey,
  isOpenRouter,
} from "./openai";
import { deadlineSignal } from "./request-timeout";
import { embeddingDimensions, EmbeddingValidationError, resolveEmbeddingConfig, validateEmbedding, type EmbeddingConfig } from "./embedding-contract";
import type { UsageRecorder } from "../tools/usage";

/**
 * 検索クエリの埋め込みベクトルを生成する。
 * The selected profile defines dimensions and the query/document task contract.
 */

const EMBEDDING_TIMEOUT_MS = 30_000;

export type EmbeddingEnv = {
  EMBEDDING_PROFILE?: string;
  EMBEDDING_PROVIDER?: string;
  AI?: Pick<Ai, "run">;
  EMBEDDING_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_FEDERATION_POLICY_ID?: string;
  OPENROUTER_FEDERATION_AUDIENCE?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  OPENAI_BASE_URL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
};

async function embedWithOpenAi(env: EmbeddingEnv, text: string, config: EmbeddingConfig, signal?: AbortSignal, costLedger?: UsageRecorder): Promise<number[]> {
  const baseURL = openAiBaseUrl({ ...env, OPENAI_BASE_URL: env.EMBEDDING_BASE_URL || env.OPENAI_BASE_URL });
  const credential = isOpenRouter(baseURL) && env.OPENROUTER_FEDERATION_POLICY_ID
    ? resolveOpenAiKey(env, "OpenAI-compatible embeddings", baseURL)
    : env.EMBEDDING_API_KEY || resolveOpenAiKey(env, "OpenAI-compatible embeddings", baseURL);
  const apiKey = typeof credential === "function" ? await credential() : credential;
  const call = costLedger?.begin("query_embedding", config.model);
  try {
    const body: Record<string, unknown> = {
      model: config.model,
      // Prompts from the pinned model config_sentence_transformers.json.
      input: config.profile === "embeddinggemma2" ? `task: search result | query: ${text}` : text,
      encoding_format: "float",
      // vLLM expects dimensions unset for this model; its native output is 768.
      ...(config.profile === "embeddinggemma2" ? {} : { dimensions: embeddingDimensions(config) }),
    };

    let res: Response;
    try {
      res = await fetch(`${baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: deadlineSignal(EMBEDDING_TIMEOUT_MS, signal),
      });
    } catch {
      signal?.throwIfAborted();
      throw new LlmProviderError("OpenAI embeddings request failed. Check the server connection.");
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) throw new LlmConfigurationError("Invalid OpenAI API key. Check the server configuration.");
      throw new LlmProviderError(`OpenAI embeddings failed (HTTP ${res.status}).`);
    }

    const json: unknown = await embeddingJson(res, config, signal);
    if (isRecord(json)) call?.complete(json.usage);
    if (!isRecord(json) || !Array.isArray(json.data) || json.data.length !== 1 ||
        !isRecord(json.data[0]) || json.data[0].index !== 0) {
      throw new EmbeddingValidationError("EMBEDDING_OUTPUT_INVALID", config);
    }
    return validateEmbedding(json.data[0].embedding, "EMBEDDING_OUTPUT_INVALID", config);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") call?.interrupt();
    else call?.fail();
    throw error;
  }
}

export async function embedQuery(env: EmbeddingEnv, text: string, signal?: AbortSignal, costLedger?: UsageRecorder): Promise<number[]> {
  signal?.throwIfAborted();
  const config = resolveEmbeddingConfig(env);
  const result = config.provider === "workers-ai"
    ? (await embedWithWorkersAi(env, [text], "query", config, signal, costLedger))[0]
    : await embedWithOpenAi(env, text, config, signal, costLedger);
  signal?.throwIfAborted();
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function embeddingJson(res: Response, config: EmbeddingConfig, signal?: AbortSignal): Promise<unknown> {
  try { return await res.json(); }
  catch {
    signal?.throwIfAborted();
    throw new EmbeddingValidationError("EMBEDDING_OUTPUT_INVALID", config);
  }
}


export type EmbeddingInputType = "query" | "document";

/** Shared input contract for search and the authenticated ingestion endpoint. */
export async function embedTexts(env: EmbeddingEnv, texts: string[], inputType: EmbeddingInputType, signal?: AbortSignal): Promise<number[][]> {
  signal?.throwIfAborted();
  const config = resolveEmbeddingConfig(env);
  if (config.provider !== "workers-ai") throw new LlmConfigurationError("Shared embedding generation requires the Workers AI provider.");
  if (texts.length === 0) return [];
  return embedWithWorkersAi(env, texts, inputType, config, signal);
}

async function embedWithWorkersAi(env: EmbeddingEnv, texts: string[], inputType: EmbeddingInputType, config: EmbeddingConfig, signal?: AbortSignal, costLedger?: UsageRecorder): Promise<number[][]> {
  if (!env.AI) throw new LlmConfigurationError("Workers AI embeddings require the AI binding.");
  const deadline = deadlineSignal(EMBEDDING_TIMEOUT_MS, signal);
  const call = costLedger?.begin("query_embedding", config.model);
  let usage: unknown;
  let transportError: unknown;
  const bindingFetch = workersAiEmbeddingFetch(env.AI, config, deadline, value => { usage = value; });
  const embeddings = new OpenAIEmbeddings({
    model: config.model, dimensions: embeddingDimensions(config), encodingFormat: "float",
    stripNewLines: false, batchSize: 32, maxConcurrency: 2, maxRetries: 0,
    timeout: EMBEDDING_TIMEOUT_MS,
    configuration: {
      baseURL: "https://workers-ai.invalid/v1", apiKey: "binding", fetch: async (input, init) => {
        try { return await bindingFetch(input, init); }
        catch (error) { transportError = error; throw error; }
      },
    },
  });
  try {
    const inputs = texts.map(text => inputType === "query"
      ? `task: search result | query: ${text}`
      : `title: none | text: ${text}`);
    const vectors = await embeddings.embedDocuments(inputs);
    deadline.throwIfAborted();
    if (vectors.length !== texts.length) throw new EmbeddingValidationError("EMBEDDING_OUTPUT_INVALID", config);
    vectors.forEach(vector => validateEmbedding(vector, "EMBEDDING_OUTPUT_INVALID", config));
    call?.complete(usage);
    return vectors;
  } catch {
    if (deadline.aborted) { call?.interrupt(); deadline.throwIfAborted(); }
    call?.fail();
    if (transportError instanceof EmbeddingValidationError) throw transportError;
    throw new LlmProviderError("Workers AI embeddings request failed. Check the server configuration.");
  }
}
