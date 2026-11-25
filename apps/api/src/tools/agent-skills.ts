import { z } from 'zod';
import { skillBundleSchema } from '@videoq/trpc/skills';
import { agentSkillService } from '../integrations/agent-skills';
import { ApplicationError } from '../application/errors';
import { defineTool } from './definition';
import { ToolError } from './errors';
import type { ToolActorContext } from './management';
export function createSkillTools(ctx: ToolActorContext) {
  return [defineTool(async ({ skill_id }) => {
    try {
      return { skill: await (await agentSkillService(ctx.env, ctx.env.FRONTEND_URL || ctx.env.BETTER_AUTH_URL)).bundle(ctx.userId, skill_id) };
    } catch (error) {
      if (error instanceof ApplicationError) throw new ToolError(error.message, { status: error.kind === 'not_found' ? 404 : 409, code: error.code });
      throw error;
    }
  }, { name: 'get_skill', description: 'Download a generated, source-checked skill set automatically published for its owner in VideoQ. Requires skill_id from the course/video skill dialog. Read-only; never generates content or spends AI allowance. Rejects drafts, inaccessible or changed source videos.',
    schema: z.object({ skill_id: z.uuid() }).strict(), outputSchema: z.object({ skill: skillBundleSchema }), resultFormat: 'flat', access: 'read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })];
}
