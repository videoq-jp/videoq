import { z } from "zod";

export type ToolExecution = { signal: AbortSignal; reportProgress?: (event: Record<string, unknown>) => Promise<void> };
export type ToolValue = string | Record<string, unknown>;

/** Framework-independent tool contract. Authorization is captured by the factory. */
export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodObject;
  invoke(input: unknown, execution: ToolExecution): Promise<ToolValue>;
};

export function defineTool<S extends z.ZodObject>(
  execute: (input: z.output<S>, execution: ToolExecution) => Promise<ToolValue>,
  config: { name: string; description: string; schema: S },
): ToolDefinition {
  return {
    ...config,
    async invoke(input, execution) {
      execution.signal.throwIfAborted();
      const result = await execute(config.schema.parse(input), execution);
      execution.signal.throwIfAborted();
      return result;
    },
  };
}
