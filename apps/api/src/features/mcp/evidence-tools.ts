import { z } from "zod";
import { executeExternalEvidenceTool } from '../../integrations/external-evidence';
import type { ToolActorContext } from "../../tools/management";
import { createEvidenceSession } from "../../tools/session";
import type { ToolDefinition } from "../../tools/definition";

/** External callers select a course; the server derives owner and allowed videos. */
export function createExternalEvidenceTools(ctx: ToolActorContext) {
  const templates = createEvidenceSession(ctx.env, { ownerUserId: ctx.userId, videoIds: [], courseId: 1 }, new AbortController().signal);
  const definitions: ToolDefinition[] = templates.tools.map(template => {
    const schema = template.schema.extend({ course_id: z.number().int().positive().safe() }).strict();
    return {
      name: template.name,
      description: `${template.description} External callers must provide course_id from list_courses. Usage limits in this description apply to this execution scope; account limits also apply across requests.`,
      schema,
      async invoke(input, execution) {
        const parsed = schema.parse(input);
        const course_id = z.number().int().positive().safe().parse(parsed.course_id);
        const { course_id: _courseId, ...args } = parsed;
        return executeExternalEvidenceTool(ctx.env, ctx.userId, course_id, template.name, args, execution);
      },
    };
  });
  return definitions;
}
