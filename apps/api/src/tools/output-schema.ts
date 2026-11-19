import { z } from "zod";

export const publicToolErrorSchema = z.object({
  status: z.number().int().min(400).max(599),
  code: z.string(),
  details: z.unknown().optional(),
  retry_after_seconds: z.number().int().positive().optional(),
}).strict();

const schemas = new WeakMap<z.ZodObject, z.ZodObject>();

/** Keep flat legacy errors compatible with clients that also validate isError results.
 * MCP requires an object output schema; retain exact success/error branches in
 * JSON Schema as well as runtime validation, rather than relaxing required fields.
 */
export function withPublicToolErrors(success: z.ZodObject): z.ZodObject {
  const cached = schemas.get(success);
  if (cached) return cached;
  const strictSuccess = success.strict();
  const schema = strictSuccess.partial().extend(publicToolErrorSchema.partial().shape).strict()
    .superRefine((value, context) => {
      if (!strictSuccess.safeParse(value).success && !publicToolErrorSchema.safeParse(value).success) {
        context.addIssue({ code: "custom", message: "Expected a tool result or a public tool error." });
      }
    }).meta({ anyOf: [z.toJSONSchema(strictSuccess), z.toJSONSchema(publicToolErrorSchema)] });
  schemas.set(success, schema);
  return schema;
}
