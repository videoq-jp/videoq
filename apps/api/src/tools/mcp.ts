import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { withPublicToolErrors } from "./output-schema";
import { ToolError } from "./errors";
import { toolResponseSchema } from "./contract";
import type { ToolDefinition, ToolValue } from "./definition";

const evidenceOutputSchema = z.object({ result: toolResponseSchema.shape.result.optional(), error: z.object({ code: z.string() }).optional() });

export function toToolResult(result: ToolValue): CallToolResult {
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }], structuredContent: { result } };
}

/** Same registrations serve local clients and the authenticated HTTP endpoint. */
export function registerTools(server: McpServer, tools: readonly ToolDefinition[], signal?: AbortSignal) {
  for (const definition of tools) {
    server.registerTool(definition.name, {
      title: definition.title ?? definition.name.replaceAll("_", " "),
      description: definition.description,
      inputSchema: definition.schema,
      outputSchema: withPublicToolErrors(definition.outputSchema ?? evidenceOutputSchema),
      annotations: definition.annotations ?? { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (input, extra) => {
      const callSignal = signal ? AbortSignal.any([signal, extra.signal]) : extra.signal;
      let progress = 0;
      try {
        const value = await definition.invoke(input, {
          signal: callSignal,
          reportProgress: async event => {
            const progressToken = extra._meta?.progressToken;
            if (progressToken !== undefined) await extra.sendNotification({
              method: "notifications/progress", params: { progressToken, progress: ++progress, total: 2, message: JSON.stringify(event) },
            });
          },
        });
        return definition.resultFormat === "flat"
          ? { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown>, isError: false }
          : toToolResult(value);
      } catch (error) {
        if (callSignal.aborted) throw error;
        if (error instanceof ToolError) return {
          isError: true, content: [{ type: "text", text: error.message }],
          ...(error.data && typeof error.data === "object" && !Array.isArray(error.data)
            ? { structuredContent: error.data as Record<string, unknown> } : {}),
        };
        if (definition.failureMode === "propagate") throw error;
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
