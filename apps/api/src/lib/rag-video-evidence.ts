import { tool } from "langchain";
import { createVideoEvidenceTools } from "../tools/video-evidence";
import { formatEvidenceResult } from "./rag-mcp-tools";
import type { Bindings } from "../types/bindings";
import type { EvidenceScope } from "../repositories/video-evidence-repository";
import type { SceneHit } from "../repositories/vector-repository";
import type { UsageRecorder } from "../tools/usage";

/** Compatibility adapter for existing direct-tool consumers; RAG uses MCP. */
export function videoEvidenceTools(env: Bindings, scope: EvidenceScope, addSource: (hit: SceneHit) => number, signal: AbortSignal, question?: string, usage?: UsageRecorder) {
  return createVideoEvidenceTools(env, scope, question, usage).map(definition => tool(async input =>
    formatEvidenceResult(definition.name, await definition.invoke(input, { signal }), addSource), definition));
}
