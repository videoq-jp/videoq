import { z } from 'zod';
import { skillBundleSchema } from '@videoq/trpc/skills';
import { agentSkillService } from '../integrations/agent-skills';
import { ApplicationError } from '../application/errors';
import { defineTool } from './definition';
import { ToolError } from './errors';
import type { ToolActorContext } from './management';
export function createSkillTools(ctx: ToolActorContext) {
  return [defineTool(async ({ skill_id, offset, limit }) => {
    try {
      return { skill: await (await agentSkillService(ctx.env, ctx.env.FRONTEND_URL || ctx.env.BETTER_AUTH_URL)).bundle(ctx.userId, skill_id, offset !== undefined || limit !== undefined ? { offset: offset ?? 0, limit: limit ?? 1 } : undefined) };
    } catch (error) {
      if (error instanceof ApplicationError) throw new ToolError(error.message, { status: error.kind === 'not_found' ? 404 : 409, code: error.code });
      throw error;
    }
  }, { name: 'get_skill', description: 'Download a generated, source-checked skill set automatically published for its owner in VideoQ. Requires skill_id from the course/video skill dialog. Pass offset and limit to download large sets in pages; follow nextOffset until null. Read-only; never generates content or spends AI allowance. Rejects drafts, inaccessible or changed source videos.',
    schema: z.object({ skill_id: z.uuid(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(20).optional() }).strict(), outputSchema: z.object({ skill: skillBundleSchema }), resultFormat: 'flat', access: 'read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })];
}
