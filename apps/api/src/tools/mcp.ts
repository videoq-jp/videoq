import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toolResponseSchema } from "./contract";
import type { ToolDefinition, ToolValue } from "./definition";

export function toToolResult(result: ToolValue): CallToolResult {
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }], structuredContent: { result } };
}

/** Same registrations serve local clients and the authenticated HTTP endpoint. */
export function registerEvidenceTools(server: McpServer, tools: readonly ToolDefinition[], signal?: AbortSignal) {
  for (const definition of tools) {
    server.registerTool(definition.name, {
      title: definition.name.replaceAll("_", " "),
      description: definition.description,
      inputSchema: definition.schema,
      outputSchema: z.object({ result: toolResponseSchema.shape.result.optional(), error: z.object({ code: z.string() }).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (input, extra) => {
      const callSignal = signal ? AbortSignal.any([signal, extra.signal]) : extra.signal;
      let progress = 0;
      try {
        return toToolResult(await definition.invoke(input, {
          signal: callSignal,
          reportProgress: async event => {
            const progressToken = extra._meta?.progressToken;
            if (progressToken !== undefined) await extra.sendNotification({
              method: "notifications/progress", params: { progressToken, progress: ++progress, total: 2, message: JSON.stringify(event) },
            });
          },
        }));
      } catch (error) {
        if (callSignal.aborted) throw error;
        // Infrastructure failures must stop the internal answer, rather than
        // become "no evidence". Never send SQL/provider exception details.
        return {
          isError: true,
          content: [{ type: "text", text: "Evidence tool execution failed." }],
          structuredContent: { error: {
            code: error instanceof Error && error.name === "LlmConfigurationError" ? "CONFIGURATION_ERROR" : "EXECUTION_FAILED",
          } },
        };
      }
    });
  }
}
