import { classifyJobFailure } from '../application/job-failure';
import { OpenAIEmbeddings } from "@langchain/openai";
import { workersAiEmbeddingFetch } from "./workers-ai-embedding-transport";
import {
  LlmConfigurationError,
  LlmProviderError,
  openAiBaseUrl,
  resolveOpenAiKey,
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
  EMBEDDING_REVISION?: string;
  EMBEDDING_PREPROCESSING?: string;
  EMBEDDING_PROFILE?: string;
  EMBEDDING_PROVIDER?: string;
  AI?: Pick<Ai, "run">;
  EMBEDDING_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
};

async function embedWithOpenAi(env: EmbeddingEnv, text: string, config: EmbeddingConfig, signal?: AbortSignal, costLedger?: UsageRecorder): Promise<number[]> {
  const baseURL = openAiBaseUrl({ ...env, OPENAI_BASE_URL: env.EMBEDDING_BASE_URL || env.OPENAI_BASE_URL });
  const apiKey = env.EMBEDDING_API_KEY || resolveOpenAiKey(env, "OpenAI-compatible embeddings");
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
    } catch (error) {
      signal?.throwIfAborted();
      throw new LlmProviderError("OpenAI embeddings request failed. Check the server connection.",classifyJobFailure(error));
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) throw new LlmConfigurationError("Invalid OpenAI API key. Check the server configuration.");
      throw new LlmProviderError(`OpenAI embeddings failed (HTTP ${res.status}).`,classifyJobFailure({status:res.status}));
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
  if (texts.length === 0) return [];
  if (config.provider === "workers-ai") return embedWithWorkersAi(env, texts, inputType, config, signal);
  return embedDocumentsWithOpenAi(env, texts, inputType, config, signal);
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
  } catch (error) {
    if (deadline.aborted) { call?.interrupt(); deadline.throwIfAborted(); }
    call?.fail();
    if (transportError instanceof EmbeddingValidationError) throw transportError;
    throw new LlmProviderError("Workers AI embeddings request failed. Check the server configuration.",classifyJobFailure(transportError ?? error));
  }
}

/** Indexing uses LangChain batching for hosted and private OpenAI-compatible servers. */
async function embedDocumentsWithOpenAi(env: EmbeddingEnv, texts: string[], inputType: EmbeddingInputType, config: EmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
  const baseURL = openAiBaseUrl({ ...env, OPENAI_BASE_URL: env.EMBEDDING_BASE_URL || env.OPENAI_BASE_URL });
  const apiKey = env.EMBEDDING_API_KEY || resolveOpenAiKey(env, "OpenAI-compatible embeddings");
  const inputs = texts.map(text => config.profile === "embeddinggemma2"
    ? (inputType === "query" ? "task: search result | query: " : "title: none | text: ") + text : text);
  let validationError: EmbeddingValidationError | undefined;
  const embeddings = new OpenAIEmbeddings({
    model: config.model, apiKey, stripNewLines: false, batchSize: 32, maxConcurrency: 1, maxRetries: 0,
    ...(config.profile === "embeddinggemma2" ? {} : { dimensions: embeddingDimensions(config) }),
    encodingFormat: "float", timeout: EMBEDDING_TIMEOUT_MS,
    configuration: { baseURL, fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.clone().json<{ input: string[] }>();
      const response = await fetch(new Request(request, { signal: deadlineSignal(EMBEDDING_TIMEOUT_MS, signal ? AbortSignal.any([signal, request.signal]) : request.signal) }));
      if (!response.ok) return response;
      const data: unknown = await response.clone().json();
      const invalid = (): never => {
        validationError = new EmbeddingValidationError("EMBEDDING_OUTPUT_INVALID", config);
        throw validationError;
      };
      if (!isRecord(data) || !Array.isArray(data.data) || data.data.length !== body.input.length) return invalid();
      const ordered = data.data.map((row: unknown) => {
        if (!isRecord(row) || typeof row.index !== 'number' || !Number.isSafeInteger(row.index)) return invalid();
        return { row, index: row.index };
      }).sort((a, b) => a.index - b.index).map(({ row, index }, expected) => {
        if (index !== expected) return invalid();
        return row;
      });
      // Match Python's ordering contract even if a compatible provider returns
      // valid indexed rows out of order. Never accept missing or duplicate rows.
      return Response.json({ ...data, data: ordered });
    } },
  });
  try {
    const vectors = await embeddings.embedDocuments(inputs);
    signal?.throwIfAborted();
    if (vectors.length !== texts.length) throw new EmbeddingValidationError("EMBEDDING_OUTPUT_INVALID", config);
    vectors.forEach(vector => validateEmbedding(vector, "EMBEDDING_OUTPUT_INVALID", config));
    return vectors;
  } catch (error) {
    signal?.throwIfAborted();
    if (validationError) throw validationError;
    if (error instanceof EmbeddingValidationError) throw error;
    throw new LlmProviderError("OpenAI embeddings request failed. Check the server configuration.",classifyJobFailure(error));
  }
}
