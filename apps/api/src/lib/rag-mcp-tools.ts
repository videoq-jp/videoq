import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { SceneHit } from "../repositories/vector-repository";
import { toolResponseSchema, evidenceProgressSchema } from "../tools/contract";
import { isAnswerTool } from "../domain/conversation/answer-tool-policy";
import type { ToolValue } from "../tools/definition";
import { LlmConfigurationError, LlmProviderError } from "./openai";

const evidenceSchema = z.object({
  videoId: z.number(), title: z.string(), startTime: z.string(), endTime: z.string(), text: z.string(),
  evidenceType: z.enum(["transcript", "visual"]).optional(),
});

/** Citation numbering belongs to the answer consumer, never the MCP server. */
export function addEvidenceCitations(value: unknown, addSource: (hit: SceneHit) => number): unknown {
  if (Array.isArray(value)) return value.map(item => addEvidenceCitations(item, addSource));
  if (!value || typeof value !== "object") return value;
  const evidence = evidenceSchema.safeParse(value);
  if (evidence.success) {
    const hit = evidence.data;
    return { ...value, sourceId: addSource({
      videoId: hit.videoId, videoTitle: hit.title, startTime: hit.startTime, endTime: hit.endTime,
      content: hit.text, evidenceType: hit.evidenceType,
    }) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, addEvidenceCitations(item, addSource)]));
}

export function formatEvidenceResult(name: string, value: ToolValue, addSource: (hit: SceneHit) => number) {
  if (typeof value === "string") return value;
  const cited = addEvidenceCitations(value, addSource);
  if (name === "search_scenes" && cited && typeof cited === "object" && "scenes" in cited && Array.isArray(cited.scenes)) {
    return cited.scenes.map(scene => JSON.stringify(scene)).join("\n\n");
  }
  return JSON.stringify(cited);
}

export type RagEvidenceOptions = {
  addSource: (hit: SceneHit) => number;
  collectContext: (text: string) => void;
  /** User selection is narrower than the session's authorization boundary. */
  selectedVideoIds?: () => readonly number[] | null;
};

/** Both the mandatory search and ReAct use this adapter and the same MCP session. */
export async function callRagEvidenceTool(
  client: Client, signal: AbortSignal, name: string, input: Record<string, unknown>,
  options: RagEvidenceOptions, writer?: (event: unknown) => void,
  required = false,
): Promise<string> {
  signal.throwIfAborted();
  const selected = options.selectedVideoIds?.();
  if (selected) {
    if (name === "search_scenes") {
      const ids = input.video_ids;
      if (Array.isArray(ids) && ids.some((id: unknown) => typeof id !== "number" || !selected.includes(id))) {
        throw new LlmProviderError("Search requested a video outside the user's selected videos.");
      }
      input = { ...input, video_ids: ids ?? [...selected] };
    } else if (typeof input.video_id === "number" && !selected.includes(input.video_id)) {
      throw new LlmProviderError("Evidence requested outside the user's selected videos.");
    }
  }
  const result = await client.callTool({ name, arguments: input }, undefined, {
    signal, timeout: 180_000,
    onprogress: progress => {
      if (!progress.message) return;
      let event: unknown;
      try { event = JSON.parse(progress.message); } catch { return; }
      const parsed = evidenceProgressSchema.safeParse(event);
      if (parsed.success) writer?.(parsed.data);
    },
  });
  signal.throwIfAborted();
  if (result.isError) {
    const structured = result.structuredContent;
    if (structured && typeof structured === "object" && "error" in structured) {
      const error = structured.error;
      if (error && typeof error === "object" && "code" in error && error.code === "CONFIGURATION_ERROR") {
        throw new LlmConfigurationError("Evidence tool configuration is invalid.");
      }
      throw new LlmProviderError("Evidence tool execution failed.");
    }
    if (required) throw new LlmProviderError("Required scene search could not execute.");
    return "Invalid tool arguments. Check the tool schema and try again.";
  }
  const value = toolResponseSchema.parse(result.structuredContent).result;
  if (name === "get_course_info" && typeof value === "object") {
    options.collectContext(`Course metadata (not subtitle scenes): ${JSON.stringify(value)}`);
  }
  return formatEvidenceResult(name, value, options.addSource);
}

/** LangChain-specific adapter. Works with any connected MCP client. */
export async function loadRagMcpTools(client: Client, signal: AbortSignal, options: RagEvidenceOptions) {
  const { tools: definitions } = await client.listTools();
  return definitions.filter(definition => isAnswerTool(definition.name)).map(definition => tool(
    async (args, runtime: ToolRuntime) => callRagEvidenceTool(
      client, signal, definition.name, z.record(z.string(), z.unknown()).parse(args), options, runtime.writer ?? undefined,
    ), {
      name: definition.name,
      description: definition.description ?? definition.name,
      schema: definition.inputSchema,
    },
  ));
}
