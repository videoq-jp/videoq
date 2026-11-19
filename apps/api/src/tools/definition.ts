import { z } from "zod";
import { ToolError } from "./errors";

export type ToolExecution = { signal: AbortSignal; reportProgress?: (event: Record<string, unknown>) => Promise<void> };
export type ToolValue = string | Record<string, unknown>;

export type ToolMetadata = {
  title?: string;
  outputSchema?: z.ZodObject;
  resultFormat?: "flat" | "envelope";
  failureMode?: "propagate" | "sanitize";
  access?: "read" | "write";
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};

/** Framework-independent tool contract. Authorization is captured by the factory. */
export type ToolDefinition = ToolMetadata & {
  name: string;
  description: string;
  schema: z.ZodObject;
  invoke(input: unknown, execution: ToolExecution): Promise<ToolValue>;
};

export function defineTool<S extends z.ZodObject>(
  execute: (input: z.output<S>, execution: ToolExecution) => Promise<ToolValue>,
  config: ToolMetadata & { name: string; description: string; schema: S },
): ToolDefinition {
  return {
    ...config,
    async invoke(input, execution) {
      execution.signal.throwIfAborted();
      const parsed = config.schema.safeParse(input);
      if (!parsed.success) throw new ToolError(`Invalid arguments for ${config.name}.`, {
        status: 400, code: "VALIDATION_ERROR", details: z.flattenError<unknown>(parsed.error).fieldErrors,
      });
      const result = await execute(parsed.data, execution);
      execution.signal.throwIfAborted();
      return result;
    },
  };
}
