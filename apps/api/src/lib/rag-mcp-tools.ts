import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { SceneHit } from "../repositories/vector-repository";
import { toolResponseSchema, evidenceProgressSchema } from "../tools/contract";
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

/** LangChain-specific adapter. Works with any connected MCP client. */
export async function loadRagMcpTools(
  client: Client, signal: AbortSignal,
  options: { addSource: (hit: SceneHit) => number; collectContext: (text: string) => void },
) {
  const { tools: definitions } = await client.listTools();
  const tools = definitions.map(definition => tool(async (args, runtime: ToolRuntime) => {
    signal.throwIfAborted();
    const input = z.record(z.string(), z.unknown()).parse(args);
    const result = await client.callTool({ name: definition.name, arguments: input }, undefined, {
      signal, timeout: 180_000,
      onprogress: progress => {
        if (!progress.message) return;
        let event: unknown;
        try { event = JSON.parse(progress.message); } catch { return; }
        const parsed = evidenceProgressSchema.safeParse(event);
        if (parsed.success) runtime.writer?.(parsed.data);
      },
    });
    if (result.isError) {
      const structured = result.structuredContent;
      if (structured && typeof structured === "object" && "error" in structured) {
        const error = structured.error;
        if (error && typeof error === "object" && "code" in error && error.code === "CONFIGURATION_ERROR") {
          throw new LlmConfigurationError("Evidence tool configuration is invalid.");
        }
        throw new LlmProviderError("Evidence tool execution failed.");
      }
      // MCP validation errors remain correctable by the model.
      return "Invalid tool arguments. Check the tool schema and try again.";
    }
    const value = toolResponseSchema.parse(result.structuredContent).result;
    if (definition.name === "get_course_info" && typeof value === "object") {
      options.collectContext(`Course metadata (not subtitle scenes): ${JSON.stringify(value)}`);
    }
    return formatEvidenceResult(definition.name, value, options.addSource);
  }, {
    name: definition.name,
    description: definition.description ?? definition.name,
    schema: definition.inputSchema,
  }));
  return tools;
}
